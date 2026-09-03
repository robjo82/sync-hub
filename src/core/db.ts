import Database from 'better-sqlite3';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { modelForEra, providerForThread } from './era-models.js';
import { scanText, maskSecret } from './secret-scan.js';
import type { AccountSyncOverview, ApiToken, Artifact, CreateSharedThreadInput, DeviceSession, EngineStats, EngineType, IngestEventStatus, IngestLogEntry, McpCallLogEntry, Memory, Message, Project, ProjectAliases, PullBatch, RemoteSyncState, SecretScanResult, Session, SharedThread, SyncOverview, Thread, TokenUsage, UpdateSharedThreadInput, User, UserRole, UserWithPasswordHash } from '../types.js';

export interface UsageScope {
  projectId?: string;
  threadId?: string;
  engine?: string;
  startDate?: string;
  endDate?: string;
}

/** One priced-or-estimated turn's worth of usage — raw material for cost aggregation (core/cost.ts). */
export interface UsageRecord {
  timestamp: string;
  projectId: string;
  threadId: string;
  sourceEngine: EngineType;
  /** Undefined means "don't know which model" — never guessed, so estimateCostUsd correctly treats it as unpriced. */
  model?: string;
  usage: TokenUsage;
  /** True for Antigravity's text-length-derived estimate — never a real, engine-reported figure. */
  isEstimated: boolean;
  /**
   * True when even the model is a guess: a Claude.ai / ChatGPT archive names no model, so the
   * flagship of that date stands in (see era-models.ts). Counted as an upper bound and kept out
   * of the headline total — the rate assumed is the dearest one on offer at the time.
   */
  isInferredModel?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '{"paths":[],"claudeSlugs":[],"codexCwds":[]}',
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  owner_user_id TEXT REFERENCES users(id),
  -- Scoped to the owner rather than global. Two people syncing to the same hub can genuinely
  -- both have /workspace/odoo: Cowork sessions run in a sandboxed VM whose cwd is identical from
  -- one machine to the next. Under a global UNIQUE the second one collides, and applyRemoteBatch
  -- skips a colliding row by design — so a colleague's project would disappear with no error
  -- raised anywhere. NULL owners (a local single-user store) never collide with each other in
  -- SQLite, which is the behaviour we want there too.
  UNIQUE (owner_user_id, canonical_path)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  origin_engine TEXT NOT NULL,
  engine_ids TEXT NOT NULL DEFAULT '{}',
  source_ref TEXT,
  source_file_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  source_engine TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  thought TEXT,
  tool_calls TEXT,
  tool_results TEXT,
  attachments TEXT,
  timestamp TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(hash);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_engine TEXT NOT NULL,
  category TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  last_modified_at TEXT NOT NULL,
  UNIQUE(file_path)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  thread_id TEXT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_engine TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(file_path)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine TEXT NOT NULL,
  file_path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_log_engine ON ingest_log(engine, timestamp);

-- An explicit, user-declared continuation link between two or more threads (possibly across
-- engines/tools) — never inferred from timing or content similarity. thread_id is UNIQUE: a
-- thread belongs to at most one link group, fixed once linked.
CREATE TABLE IF NOT EXISTS thread_links (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_link_members (
  link_id TEXT NOT NULL REFERENCES thread_links(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_synced_at TEXT,
  PRIMARY KEY (link_id, thread_id)
);

-- Every MCP tool call, verbatim params + outcome — the actual record of what any connected tool
-- (Claude Code, Codex, Antigravity…) asked sync-hub for and got back, so a real problem reported
-- days later ("the link didn't work") can be traced to what was actually called, not guessed at.
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  params TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_call_log_timestamp ON mcp_call_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_mcp_call_log_tool ON mcp_call_log(tool, timestamp);

-- The set of known category names, independent of whether any project currently uses one — lets
-- a category be created ahead of assigning it to anything, renamed everywhere at once (a project
-- row only stores the string, not a foreign key, so a rename here doesn't cascade automatically —
-- Db.renameCategory updates both), and listed for the dashboard's picker instead of the caller
-- having to guess spelling from memory.
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Full-text indexes backing searchTranscripts — standalone (not "external content") FTS5 tables,
-- kept in sync manually at each write site rather than via SQLite triggers, matching how every
-- other write in this file already works. remove_diacritics 2 folds accents at index AND query
-- time ("a" matches "à"), which plain LIKE never did — real find: a query for the literal typed
-- title of a thread still failed to find it because LIKE requires byte-exact substrings, and FTS5
-- phrase queries ("...") give an exact-phrase match real priority over scattered-word coincidences,
-- via bm25() relevance ranking instead of ordering by recency alone.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  message_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
  title,
  thread_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Per-remote push/pull watermarks for the client side of remote sync — how
-- far this instance has pushed to and pulled from a given hub. Keyed by remote_url rather than a single row so
-- the same local store could in principle sync with more than one hub independently.
CREATE TABLE IF NOT EXISTS remote_sync_state (
  remote_url TEXT PRIMARY KEY,
  last_pushed_seq INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT,
  last_pulled_seq INTEGER NOT NULL DEFAULT 0,
  last_pulled_at TEXT
);

-- Users and roles (admin / member) for authentication and multi-user access control.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Active authenticated sessions, indexed by token_hash (SHA-256 over random raw token).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Long-lived machine credentials, one per user per device, for the sync path. Distinct from
-- sessions: a session belongs to a human in front of a browser and expires; an api_token
-- belongs to a daemon that must keep pushing unattended, and only ever stops when revoked.
-- Replaces the single shared SYNC_HUB_REMOTE_TOKEN, which could not attribute a push to anyone
-- nor be revoked for one person without cutting off everybody.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- Who, besides its owner, may read a project. Distinct from shared_threads, which mints a public
-- link for one conversation to someone with no account: this grants a named colleague standing
-- access to a whole project. Project-grained on purpose — a thread belongs to exactly one
-- project, so threads and messages inherit visibility by join and need no column of their own.
CREATE TABLE IF NOT EXISTS project_shares (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_shares_user ON project_shares(user_id);

-- Shared threads for public/external read-only link access.
CREATE TABLE IF NOT EXISTS shared_threads (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_threads_token ON shared_threads(share_token);
CREATE INDEX IF NOT EXISTS idx_shared_threads_thread ON shared_threads(thread_id);
CREATE INDEX IF NOT EXISTS idx_shared_threads_user ON shared_threads(created_by_user_id);
`;

/**
 * CREATE TABLE IF NOT EXISTS only handles brand-new databases — it never adds a column to an
 * already-existing table, so a schema column added after a database file was first created
 * (like `archived`/`source_file_path` were, mid-session) would otherwise crash every query that
 * references it against any pre-existing hub.sqlite. This is the lightweight migration path for
 * exactly that: additive, idempotent, no destructive schema changes.
 */
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * The full current column set, one entry per column that could plausibly be missing from an
 * older database file — kept in sync with SCHEMA above. Checking every column here (not just the
 * ones known to have been added after the fact) means a forgotten one can never repeat the
 * "table X has no column named Y" crash this fixes.
 */
const EXPECTED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'projects', column: 'archived', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'projects', column: 'sort_order', definition: 'INTEGER' },
  { table: 'projects', column: 'category', definition: 'TEXT' },
  { table: 'projects', column: 'owner_user_id', definition: 'TEXT REFERENCES users(id)' },
  { table: 'threads', column: 'source_ref', definition: 'TEXT' },
  { table: 'threads', column: 'source_file_path', definition: 'TEXT' },
  { table: 'messages', column: 'model', definition: 'TEXT' },
  { table: 'messages', column: 'usage', definition: 'TEXT' },
  { table: 'messages', column: 'estimated_tokens', definition: 'INTEGER' },
  { table: 'messages', column: 'ingest_seq', definition: 'INTEGER' },
  { table: 'remote_sync_state', column: 'last_pulled_seq', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'remote_sync_state', column: 'last_pulled_at', definition: 'TEXT' },
];

const DEFAULT_CATEGORIES = ['ekonum', 'client', 'perso'];


/**
 * Masks every credential in an excerpt, not only the one being reported.
 *
 * The context window around a finding routinely contains a second secret — an Authorization
 * header next to a URL, two keys in one env block. Masking only the reported value would leave
 * the others printed in full on the very screen built to stop that happening.
 */
function maskEverySecret(excerpt: string, reported: string): string {
  let out = excerpt;
  const values = new Set<string>([reported, ...scanText(excerpt).map((f) => f.value)]);
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (!value) continue;
    out = out.split(value).join(`«${maskSecret(value)}»`);
  }
  return out;
}


/**
 * Token count for arbitrary stored text.
 *
 * The exported ChatGPT archives contain literal control markers like `<|im_sep|>` as ordinary
 * characters, and gpt-tokenizer rejects those outright — which crashed the daemon at startup,
 * before it could serve anything, the first time archives were counted. They are just text here,
 * so the check is disabled; a failure still falls back to a rough estimate rather than taking
 * the process down over a token count.
 */
function countTokens(text: string): number {
  try {
    // 'all' : these markers are ordinary characters in an exported transcript, not instructions.
    return encode(text, { allowedSpecial: 'all' }).length;
  } catch {
    // ~4 characters per token is the usual English/French ballpark — wrong, but bounded, and
    // infinitely better than refusing to start.
    return Math.ceil(text.length / 4);
  }
}

export class Db {
  readonly raw: Database.Database;
  /** Next value to assign to messages.ingest_seq — see backfillIngestSeq's doc for why this exists
   * instead of using SQLite's own rowid or the message's own timestamp. */
  private nextIngestSeq: number;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.raw = new Database(filePath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
    for (const { table, column, definition } of EXPECTED_COLUMNS) {
      ensureColumn(this.raw, table, column, definition);
    }
    this.migrateProjectUniqueness();
    this.adoptOrphanProjectsOnSingleUserStore();
    // The minimum set asked for — seeded once so they always show up in the picker, even before
    // any project has been sorted into one yet. createCategory is idempotent (INSERT OR IGNORE).
    for (const name of DEFAULT_CATEGORIES) this.createCategory(name);
    this.backfillFts();
    this.backfillEstimatedTokens();
    this.nextIngestSeq = (this.raw.prepare('SELECT COALESCE(MAX(ingest_seq), 0) AS n FROM messages').get() as any).n;
    this.backfillIngestSeq();
  }

  /**
   * One-time catch-up for messages.ingest_seq, backing the remote-push watermark (see
   * getMessagesAfterSeq / core/sync-push-client.ts). Neither SQLite's own rowid (this table has
   * no AUTOINCREMENT, so a deleted row's rowid can be reused — deleteProject/deleteThread/
   * mergeProjects all delete message rows) nor `timestamp` (the conversation's own event time, not
   * ingest time — a backfill can insert an old-timestamped row at any point, and real ties are
   * common within one ingest batch) is safe to watermark against, so this assigns a private,
   * strictly-increasing sequence instead, once per row, ordered by rowid over the static
   * pre-existing corpus (safe only because nothing is concurrently deleting rows during this pass).
   */
  /**
   * Moves an existing database from projects.canonical_path being globally UNIQUE to
   * UNIQUE(owner_user_id, canonical_path). SQLite cannot drop a constraint in place, so the table
   * has to be rebuilt — see the SCHEMA comment for why the global one becomes actively harmful as
   * soon as more than one person syncs to the same hub.
   *
   * Only `projects` is copied: every foreign key points at projects.id, which does not change, so
   * threads and messages are untouched (166k rows stay where they are). Guarded by a check of the
   * live index list, so it runs once and is a no-op on every later boot.
   */
  private migrateProjectUniqueness(): void {
    const indexes = this.raw.prepare(`PRAGMA index_list(projects)`).all() as { name: string; unique: number }[];
    const hasScopedUnique = indexes.some((idx) => {
      if (!idx.unique) return false;
      const cols = (this.raw.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all() as { name: string }[]).map((c) => c.name);
      return cols.includes('owner_user_id') && cols.includes('canonical_path');
    });
    if (hasScopedUnique) return;

    // foreign_keys must be off around the rename, or the child tables' references to `projects`
    // would be rewritten to point at the temporary table. It is a connection-level pragma and
    // cannot be changed inside a transaction, hence the ordering here.
    this.raw.pragma('foreign_keys = OFF');
    try {
      this.raw.transaction(() => {
        this.raw.exec(`
          CREATE TABLE projects_migrated (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            aliases TEXT NOT NULL DEFAULT '{"paths":[],"claudeSlugs":[],"codexCwds":[]}',
            created_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER,
            category TEXT,
            owner_user_id TEXT REFERENCES users(id),
            UNIQUE (owner_user_id, canonical_path)
          );
          INSERT INTO projects_migrated
            (id, name, canonical_path, aliases, created_at, last_active_at, archived, sort_order, category, owner_user_id)
            SELECT id, name, canonical_path, aliases, created_at, last_active_at, archived, sort_order, category, owner_user_id
            FROM projects;
          DROP TABLE projects;
          ALTER TABLE projects_migrated RENAME TO projects;
        `);
      })();
      const violations = this.raw.prepare(`PRAGMA foreign_key_check`).all();
      if (violations.length > 0) {
        // Loud rather than silent: a broken reference here would surface much later as threads
        // that belong to nothing.
        console.error(`migrateProjectUniqueness: ${violations.length} foreign key violation(s) after rebuild`, violations.slice(0, 5));
      }
    } finally {
      this.raw.pragma('foreign_keys = ON');
    }
  }

  private backfillIngestSeq(): void {
    // Declared here rather than in SCHEMA because ingest_seq is added by ensureColumn, which runs
    // after SCHEMA. Serves both directions: the IS NULL probe below (NULLs sort first in a SQLite
    // index, so an already-backfilled corpus answers from the index instead of scanning the whole
    // messages table on every single startup) and getMessagesAfterSeq's range scan on every push.
    this.raw.exec('CREATE INDEX IF NOT EXISTS idx_messages_ingest_seq ON messages(ingest_seq)');

    const update = this.raw.prepare('UPDATE messages SET ingest_seq = ? WHERE rowid = ?');
    // Batched rather than one pass over the whole corpus: 150k+ rows in a single transaction
    // builds a multi-hundred-MB WAL and, if the process dies before it commits, redoes everything
    // from scratch on the next boot — a loop that never converges. Each batch commits on its own,
    // so an interrupted backfill resumes where it stopped.
    const BATCH = 5_000;
    let total = 0;
    for (;;) {
      const rows = this.raw
        .prepare('SELECT rowid AS rid FROM messages WHERE ingest_seq IS NULL ORDER BY rowid ASC LIMIT ?')
        .all(BATCH) as { rid: number }[];
      if (rows.length === 0) break;
      const base = this.nextIngestSeq;
      this.raw.transaction(() => {
        rows.forEach((r, i) => update.run(base + i + 1, r.rid));
      })();
      this.nextIngestSeq += rows.length;
      total += rows.length;
    }
    // A large catch-up leaves a WAL far bigger than steady-state traffic ever would; fold it back
    // in once here rather than letting every later read pay to search it.
    if (total > 0) this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Populates messages_fts/threads_fts for any row that predates the FTS5 tables (a brand-new
   * database has none of either, and this fills the whole corpus once) — safe to call on every
   * startup since the NOT IN subquery is a no-op once caught up. insertMessage/upsertThread keep
   * both indexes current incrementally from then on; this only ever catches a one-time gap.
   */
  private backfillFts(): void {
    this.raw.exec(`
      INSERT INTO messages_fts (content, message_id)
      SELECT content, id FROM messages WHERE id NOT IN (SELECT message_id FROM messages_fts);
    `);
    this.raw.exec(`
      INSERT INTO threads_fts (title, thread_id)
      SELECT title, id FROM threads WHERE id NOT IN (SELECT thread_id FROM threads_fts);
    `);
  }

  /**
   * One-time catch-up for messages.estimated_tokens (see estimateAntigravityUsage's doc for why
   * this exists) — a brand-new column is NULL on every pre-existing row, and computing it here
   * once at startup is what keeps the cost endpoint from re-tokenizing the whole Antigravity
   * corpus on every request. Only Antigravity messages get a value; every other engine already
   * reports real usage and never needs this.
   */
  private backfillEstimatedTokens(): void {
    // Antigravity reports no usage at all, and neither do the Claude.ai / ChatGPT archives — a web
    // export simply has no token field to read. Counting the tokens ourselves needs no pricing and
    // guesses nothing: it is arithmetic on text we already hold, and it is what makes those 62k
    // archived messages visible as volume instead of absent from every total.
    const rows = this.raw
      .prepare(
        `SELECT m.id, m.content, m.thought, m.tool_calls, m.tool_results
         FROM messages m
         WHERE m.estimated_tokens IS NULL AND m.usage IS NULL
           AND (m.source_engine = 'antigravity'
                OR m.thread_id LIKE 'chatgpt-export%'
                OR m.thread_id LIKE 'claude-export%')`,
      )
      .all() as any[];
    if (rows.length === 0) return;
    const update = this.raw.prepare('UPDATE messages SET estimated_tokens = ? WHERE id = ?');
    const tx = this.raw.transaction(() => {
      for (const row of rows) {
        const text = [row.content, row.thought, row.tool_calls, row.tool_results].filter(Boolean).join('\n');
        update.run(text ? countTokens(text) : 0, row.id);
      }
    });
    tx();
  }

  /**
   * A cheap stand-in for "has anything been ingested since?" — the private ingest counter only
   * ever moves forward, so comparing it is enough to know a cached aggregate is still valid.
   * Reading the in-memory counter costs nothing, unlike the aggregates it guards.
   */
  ingestVersion(): number {
    return this.nextIngestSeq;
  }

  close(): void {
    this.raw.close();
  }

  // --- projects ---------------------------------------------------------

  /** Never touches `archived` on conflict — only archiveProject/unarchiveProject change that flag, so a routine re-ingest never silently un-archives a project. */
  upsertProject(project: Project): void {
    this.raw
      .prepare(
        `INSERT INTO projects (id, name, canonical_path, aliases, created_at, last_active_at, archived)
         VALUES (@id, @name, @canonicalPath, @aliases, @createdAt, @lastActiveAt, @archived)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           canonical_path = excluded.canonical_path,
           aliases = excluded.aliases,
           last_active_at = excluded.last_active_at`,
      )
      .run({
        id: project.id,
        name: project.name,
        canonicalPath: project.canonicalPath,
        aliases: JSON.stringify(project.aliases),
        createdAt: project.createdAt,
        lastActiveAt: project.lastActiveAt,
        archived: project.archived ? 1 : 0,
      });
  }

  setProjectArchived(id: string, archived: boolean): void {
    this.raw.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  /** User-driven display name override — e.g. for a ChatGPT Project with no cached real name. */
  renameProject(id: string, name: string): void {
    this.raw.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
  }

  /** Free-form sidebar grouping (e.g. "ekonum", "perso", "client") — explicit only, never guessed. Pass null to ungroup. */
  setProjectCategory(id: string, category: string | null): void {
    this.raw.prepare('UPDATE projects SET category = ? WHERE id = ?').run(category, id);
    if (category) this.createCategory(category);
  }

  // --- categories ---------------------------------------------------------

  /** Registers a category name even before any project uses it (e.g. from the "manage categories" panel). No-op if it already exists. */
  createCategory(name: string): void {
    this.raw.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }

  /** Every known category (explicitly created, or in use by at least one project), with how many projects currently use it. */
  listCategories(): { name: string; projectCount: number }[] {
    return this.raw
      .prepare(
        `SELECT c.name AS name, COUNT(p.id) AS projectCount
         FROM categories c
         LEFT JOIN projects p ON p.category = c.name
         GROUP BY c.name
         ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as { name: string; projectCount: number }[];
  }

  /** Renames a category everywhere at once — the categories row and every project currently using it. Throws if the new name is already taken by a different category. */
  renameCategory(oldName: string, newName: string): void {
    if (oldName === newName) return;
    const existing = this.raw.prepare('SELECT 1 FROM categories WHERE name = ?').get(newName);
    if (existing) throw new Error(`renameCategory: "${newName}" existe déjà`);
    const tx = this.raw.transaction(() => {
      this.raw.prepare('UPDATE categories SET name = ? WHERE name = ?').run(newName, oldName);
      this.raw.prepare('UPDATE projects SET category = ? WHERE category = ?').run(newName, oldName);
    });
    tx();
  }

  /** Deletes a category outright — any project using it falls back to uncategorized (never left pointing at a name that no longer exists). Returns how many projects were affected. */
  deleteCategory(name: string): number {
    const tx = this.raw.transaction(() => {
      const result = this.raw.prepare('UPDATE projects SET category = NULL WHERE category = ?').run(name);
      this.raw.prepare('DELETE FROM categories WHERE name = ?').run(name);
      return result.changes;
    });
    return tx();
  }

  /**
   * User-driven manual ordering for the dashboard's project list (drag-and-drop). Rewrites
   * sort_order sequentially for exactly the given ids, in the order given — the caller passes the
   * full desired order after a drag, not a partial diff. Projects never included here (not yet
   * manually touched, including any discovered later) keep sort_order = NULL and fall back to
   * last-activity order, sorted after every manually-ordered project.
   */
  setProjectOrder(orderedIds: string[]): void {
    const tx = this.raw.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.raw.prepare('UPDATE projects SET sort_order = ? WHERE id = ?').run(index, id);
      });
    });
    tx();
  }

  /** Manually-ordered projects first (by sort_order), then everything else by last activity. */
  getProjects(): Project[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM projects
         ORDER BY (sort_order IS NULL) ASC, sort_order ASC, last_active_at DESC`,
      )
      .all() as any[];
    return rows.map(rowToProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return row ? rowToProject(row) : undefined;
  }

  touchProjectActivity(id: string, timestamp: string): void {
    this.raw.prepare('UPDATE projects SET last_active_at = ? WHERE id = ? AND last_active_at < ?').run(timestamp, id, timestamp);
  }

  /**
   * Removes a project from sync-hub's own store. `threads`/`messages` cascade via their foreign
   * keys; `memories`/`artifacts` reference project_id without a foreign key (they're keyed by
   * file_path, not thread), so they're deleted explicitly here to avoid leaving orphaned rows.
   */
  deleteProject(id: string): void {
    const tx = this.raw.transaction(() => {
      // Same standalone-FTS5-table gap as deleteThread — the cascade from projects through
      // threads to messages never reaches messages_fts/threads_fts on its own.
      const messageIds = this.raw.prepare('SELECT id FROM messages WHERE project_id = ?').all(id) as { id: string }[];
      const deleteFromMessagesFts = this.raw.prepare('DELETE FROM messages_fts WHERE message_id = ?');
      for (const { id: messageId } of messageIds) deleteFromMessagesFts.run(messageId);
      const threadIds = this.raw.prepare('SELECT id FROM threads WHERE project_id = ?').all(id) as { id: string }[];
      const deleteFromThreadsFts = this.raw.prepare('DELETE FROM threads_fts WHERE thread_id = ?');
      for (const { id: threadId } of threadIds) deleteFromThreadsFts.run(threadId);

      this.raw.prepare('DELETE FROM memories WHERE project_id = ?').run(id);
      this.raw.prepare('DELETE FROM artifacts WHERE project_id = ?').run(id);
      this.raw.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    tx();
  }

  /**
   * Folds `sourceId` into `targetId`: every thread/message/memory/artifact moves to the target,
   * the target absorbs the source's aliases (so future ingestion of anything that used to resolve
   * to the source — a Claude slug, a Codex cwd, a ChatGPT Project template id — resolves straight
   * to the target instead), and the source project row is removed. Never touches real files on
   * disk — this is a pure DB reassignment, unlike deleteProject (which moves a real folder to
   * Trash). Used when the same real project was independently discovered under two identities
   * (e.g. a live Codex/Claude Code project and an unrelated-looking ChatGPT Project).
   */
  mergeProjects(sourceId: string, targetId: string): void {
    if (sourceId === targetId) throw new Error('Cannot merge a project into itself');
    const source = this.getProject(sourceId);
    const target = this.getProject(targetId);
    if (!source || !target) throw new Error('mergeProjects: source or target project not found');

    const CHATGPT_PROJECT_PREFIX = 'chatgpt-project-';
    const sourceTemplateId = source.id.startsWith(CHATGPT_PROJECT_PREFIX) ? source.id.slice(CHATGPT_PROJECT_PREFIX.length) : undefined;
    const dedupe = (values: string[]): string[] => Array.from(new Set(values));
    const mergedAliases: ProjectAliases = {
      paths: dedupe([
        ...target.aliases.paths,
        ...source.aliases.paths,
        ...(source.canonicalPath && !source.canonicalPath.includes('://') ? [source.canonicalPath] : []),
      ]),
      claudeSlugs: dedupe([...target.aliases.claudeSlugs, ...source.aliases.claudeSlugs]),
      codexCwds: dedupe([...target.aliases.codexCwds, ...source.aliases.codexCwds]),
      chatgptProjectIds: dedupe([
        ...(target.aliases.chatgptProjectIds ?? []),
        ...(source.aliases.chatgptProjectIds ?? []),
        ...(sourceTemplateId ? [sourceTemplateId] : []),
      ]),
    };

    const tx = this.raw.transaction(() => {
      this.raw.prepare('UPDATE threads SET project_id = ? WHERE project_id = ?').run(targetId, sourceId);
      this.raw.prepare('UPDATE messages SET project_id = ? WHERE project_id = ?').run(targetId, sourceId);
      this.raw.prepare('UPDATE memories SET project_id = ? WHERE project_id = ?').run(targetId, sourceId);
      this.raw.prepare('UPDATE artifacts SET project_id = ? WHERE project_id = ?').run(targetId, sourceId);
      this.raw.prepare('UPDATE projects SET aliases = ?, last_active_at = ? WHERE id = ?').run(
        JSON.stringify(mergedAliases),
        source.lastActiveAt > target.lastActiveAt ? source.lastActiveAt : target.lastActiveAt,
        targetId,
      );
      this.raw.prepare('DELETE FROM projects WHERE id = ?').run(sourceId);
    });
    tx();
  }

  // --- threads ------------------------------------------------------------

  /**
   * Never touches `status` on conflict — only archiveThread/unarchiveThread change that flag.
   * Without this, a routine re-scan (which always ingests with status:'active') would silently
   * un-archive a thread the moment its source file is seen again — e.g. a Codex thread archived
   * into ~/.codex/archived_sessions/ is still discovered by the Codex adapter's own scan of that
   * directory, so its row would otherwise flip back to active on the very next full scan.
   */
  upsertThread(thread: Thread): void {
    this.raw
      .prepare(
        `INSERT INTO threads (id, project_id, title, origin_engine, engine_ids, source_ref, source_file_path, created_at, updated_at, status)
         VALUES (@id, @projectId, @title, @originEngine, @engineIds, @sourceRef, @sourceFilePath, @createdAt, @updatedAt, @status)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           engine_ids = excluded.engine_ids,
           source_ref = excluded.source_ref,
           source_file_path = excluded.source_file_path,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        originEngine: thread.originEngine,
        engineIds: JSON.stringify(thread.engineIds),
        sourceRef: thread.sourceRef ?? null,
        sourceFilePath: thread.sourceFilePath ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
      });
    this.raw.prepare('DELETE FROM threads_fts WHERE thread_id = ?').run(thread.id);
    this.raw.prepare('INSERT INTO threads_fts (title, thread_id) VALUES (?, ?)').run(thread.title, thread.id);
  }

  setThreadStatus(id: string, status: 'active' | 'archived'): void {
    this.raw.prepare('UPDATE threads SET status = ? WHERE id = ?').run(status, id);
  }

  /** Removes the thread and (via ON DELETE CASCADE) its messages from sync-hub's own store — never
   * the real source file, which archive.deleteThread moves aside first, the same safe way
   * archiveThread does. Purely a sync-hub-side purge, e.g. for accidental duplicate imports. */
  deleteThread(id: string): void {
    // messages_fts/threads_fts are standalone FTS5 tables — the messages.thread_id FK's ON DELETE
    // CASCADE cleans up `messages` itself but has no way to reach a separate virtual table, so
    // these would otherwise dangle forever and keep surfacing deleted content in search.
    const messageIds = this.raw.prepare('SELECT id FROM messages WHERE thread_id = ?').all(id) as { id: string }[];
    const deleteFromFts = this.raw.prepare('DELETE FROM messages_fts WHERE message_id = ?');
    for (const { id: messageId } of messageIds) deleteFromFts.run(messageId);
    this.raw.prepare('DELETE FROM threads_fts WHERE thread_id = ?').run(id);
    this.raw.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  getThreadsForProject(projectId: string): Thread[] {
    const rows = this.raw
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.project_id = ? ORDER BY t.updated_at DESC`,
      )
      .all(projectId) as any[];
    return rows.map(rowToThread);
  }

  getThread(id: string): Thread | undefined {
    const row = this.raw
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.id = ?`,
      )
      .get(id) as any;
    return row ? rowToThread(row) : undefined;
  }

  /** Every thread among the given ids that actually exists — used by sync-push-client to fetch the
   * exact set of threads referenced by a batch of messages being pushed to a remote hub. */
  getThreadsByIds(ids: string[]): Thread[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.id IN (${placeholders})`,
      )
      .all(...ids) as any[];
    return rows.map(rowToThread);
  }

  /** Re-parents a thread and all its messages to a different project — used by the triage flow. */
  reassignThread(threadId: string, projectId: string): void {
    const tx = this.raw.transaction(() => {
      this.raw.prepare('UPDATE threads SET project_id = ? WHERE id = ?').run(projectId, threadId);
      this.raw.prepare('UPDATE messages SET project_id = ? WHERE thread_id = ?').run(projectId, threadId);
    });
    tx();
  }

  // --- thread links ---------------------------------------------------------

  /**
   * Explicitly links two or more existing threads into one continuation group — never inferred
   * from timing or content similarity. If any of the given threads already belongs to a group,
   * the others join that same group instead of a new one being created (so linking a third thread
   * to an already-linked pair grows it to three). A thread not yet known to sync-hub (e.g. a
   * brand-new conversation whose first message hasn't been ingested yet) can't be linked yet —
   * call this once the thread exists, using the id from the dashboard's "Copier l'id du fil"
   * button, same as get_thread.
   */
  linkThreads(threadIds: string[]): string {
    const unique = Array.from(new Set(threadIds));
    if (unique.length < 2) throw new Error('linkThreads requires at least two distinct thread ids');
    for (const id of unique) {
      if (!this.getThread(id)) throw new Error(`linkThreads: unknown thread id "${id}"`);
    }

    const placeholders = unique.map(() => '?').join(',');
    const existingLinkIds = new Set(
      (this.raw.prepare(`SELECT DISTINCT link_id FROM thread_link_members WHERE thread_id IN (${placeholders})`).all(...unique) as any[]).map(
        (r) => r.link_id,
      ),
    );
    if (existingLinkIds.size > 1) {
      throw new Error('linkThreads: these threads already belong to different link groups — merging groups is not supported');
    }

    const now = new Date().toISOString();
    const linkId = existingLinkIds.size === 1 ? ([...existingLinkIds][0] as string) : randomUUID();
    const tx = this.raw.transaction(() => {
      if (existingLinkIds.size === 0) {
        this.raw.prepare('INSERT INTO thread_links (id, created_at) VALUES (?, ?)').run(linkId, now);
      }
      for (const threadId of unique) {
        this.raw
          .prepare('INSERT OR IGNORE INTO thread_link_members (link_id, thread_id, joined_at) VALUES (?, ?, ?)')
          .run(linkId, threadId, now);
      }
    });
    tx();
    return linkId;
  }

  /**
   * Removes one thread from its link group. If that leaves the group with fewer than two members,
   * the whole group is dissolved (a "group" of one is meaningless) rather than left dangling.
   */
  unlinkThread(threadId: string): void {
    const link = this.getThreadLink(threadId);
    if (!link) return;
    const tx = this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM thread_link_members WHERE thread_id = ?').run(threadId);
      const remaining = this.raw.prepare('SELECT COUNT(*) AS n FROM thread_link_members WHERE link_id = ?').get(link.linkId) as any;
      if (remaining.n < 2) {
        this.raw.prepare('DELETE FROM thread_link_members WHERE link_id = ?').run(link.linkId);
        this.raw.prepare('DELETE FROM thread_links WHERE id = ?').run(link.linkId);
      }
    });
    tx();
  }

  /** The link group a thread belongs to (its own id included), or undefined if it isn't linked. */
  getThreadLink(threadId: string): { linkId: string; threadIds: string[] } | undefined {
    const row = this.raw.prepare('SELECT link_id FROM thread_link_members WHERE thread_id = ?').get(threadId) as any;
    if (!row) return undefined;
    const members = this.raw.prepare('SELECT thread_id FROM thread_link_members WHERE link_id = ?').all(row.link_id) as any[];
    return { linkId: row.link_id, threadIds: members.map((m) => m.thread_id) };
  }

  /**
   * Verbatim messages from every OTHER thread in threadId's link group, newer than what threadId
   * has already consumed from the group — then advances threadId's own watermark to the newest
   * message returned. Delta-only by design, so resuming a linked conversation doesn't replay
   * everything each time it checks in.
   */
  getThreadLinkDelta(threadId: string): Message[] {
    const link = this.getThreadLink(threadId);
    if (!link) return [];
    const otherThreadIds = link.threadIds.filter((id) => id !== threadId);
    if (otherThreadIds.length === 0) return [];

    const member = this.raw.prepare('SELECT last_synced_at FROM thread_link_members WHERE thread_id = ?').get(threadId) as any;
    const since = member?.last_synced_at as string | null;

    const placeholders = otherThreadIds.map(() => '?').join(',');
    const rows = (
      since
        ? this.raw
            .prepare(`SELECT * FROM messages WHERE thread_id IN (${placeholders}) AND timestamp > ? ORDER BY timestamp ASC`)
            .all(...otherThreadIds, since)
        : this.raw.prepare(`SELECT * FROM messages WHERE thread_id IN (${placeholders}) ORDER BY timestamp ASC`).all(...otherThreadIds)
    ) as any[];

    if (rows.length > 0) {
      const newWatermark = rows[rows.length - 1].timestamp;
      this.raw.prepare('UPDATE thread_link_members SET last_synced_at = ? WHERE thread_id = ?').run(newWatermark, threadId);
    }
    return rows.map(rowToMessage);
  }

  // --- messages -----------------------------------------------------------

  hasMessageHash(hash: string): boolean {
    return !!this.raw.prepare('SELECT 1 FROM messages WHERE hash = ?').get(hash);
  }

  /** Returns false (and inserts nothing) when the hash already exists — the anti-duplicate gate. */
  insertMessage(message: Message): boolean {
    try {
      // Computed but not committed to this.nextIngestSeq until the INSERT actually succeeds below
      // — a failed attempt (caught by the branches beneath) must not burn a sequence number.
      const candidateSeq = this.nextIngestSeq + 1;
      this.raw
        .prepare(
          `INSERT INTO messages
             (id, thread_id, project_id, source_engine, role, content, thought, tool_calls, tool_results, attachments, timestamp, sequence, hash, metadata, model, usage, estimated_tokens, ingest_seq)
           VALUES
             (@id, @threadId, @projectId, @sourceEngine, @role, @content, @thought, @toolCalls, @toolResults, @attachments, @timestamp, @sequence, @hash, @metadata, @model, @usage, @estimatedTokens, @ingestSeq)`,
        )
        .run({
          id: message.id,
          threadId: message.threadId,
          projectId: message.projectId,
          sourceEngine: message.sourceEngine,
          role: message.role,
          content: message.content,
          thought: message.thought ?? null,
          toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          toolResults: message.toolResults ? JSON.stringify(message.toolResults) : null,
          attachments: message.attachments ? JSON.stringify(message.attachments) : null,
          timestamp: message.timestamp,
          sequence: message.sequence,
          hash: message.hash,
          metadata: message.metadata ? JSON.stringify(message.metadata) : null,
          model: message.model ?? null,
          usage: message.usage ? JSON.stringify(message.usage) : null,
          estimatedTokens: message.estimatedTokens ?? null,
          // Assigned once, only on a genuine new row — never on the hash-dedup backfill branch or
          // the id-conflict re-parse UPDATE branch below, so an existing message's position in the
          // remote-push watermark ordering never moves once assigned (see backfillIngestSeq's doc).
          ingestSeq: candidateSeq,
        });
      this.nextIngestSeq = candidateSeq;
      this.syncMessageFts(message.id, message.content);
      return true;
    } catch (err: any) {
      if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed: messages.hash')) {
        // A genuine re-ingestion of the same content (same id, same hash) — but model/usage/
        // estimated_tokens are metadata added to the adapters after most messages already existed,
        // and don't factor into the hash. Without this, an already-ingested message could never
        // pick up this metadata on a later rescan: SQLite reports the hash conflict before the id
        // conflict even though id is the primary key (verified), so the "update in place" branch
        // below never runs for an otherwise-unchanged message. Backfill just these columns when
        // they're newly available, leave everything else alone.
        if (message.model || message.usage || message.estimatedTokens != null) {
          this.raw
            .prepare(
              'UPDATE messages SET model = COALESCE(model, @model), usage = COALESCE(usage, @usage), estimated_tokens = COALESCE(estimated_tokens, @estimatedTokens) WHERE hash = @hash',
            )
            .run({
              hash: message.hash,
              model: message.model ?? null,
              usage: message.usage ? JSON.stringify(message.usage) : null,
              estimatedTokens: message.estimatedTokens ?? null,
            });
        }
        return false;
      }
      if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed: messages.id')) {
        // The id is stable (derived from the source event), but the hash is derived from parsed
        // content/thought/tool fields — when adapter parsing logic evolves (e.g. reasoning-merge
        // changes), the same source id now yields different content. Update in place rather than
        // crash-looping the daemon on every restart.
        this.raw
          .prepare(
            `UPDATE messages
               SET thread_id = @threadId, project_id = @projectId, source_engine = @sourceEngine, role = @role,
                   content = @content, thought = @thought, tool_calls = @toolCalls, tool_results = @toolResults,
                   attachments = @attachments, timestamp = @timestamp, sequence = @sequence, hash = @hash, metadata = @metadata,
                   model = @model, usage = @usage, estimated_tokens = @estimatedTokens
             WHERE id = @id`,
          )
          .run({
            id: message.id,
            threadId: message.threadId,
            projectId: message.projectId,
            sourceEngine: message.sourceEngine,
            role: message.role,
            content: message.content,
            thought: message.thought ?? null,
            toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
            toolResults: message.toolResults ? JSON.stringify(message.toolResults) : null,
            attachments: message.attachments ? JSON.stringify(message.attachments) : null,
            timestamp: message.timestamp,
            sequence: message.sequence,
            hash: message.hash,
            metadata: message.metadata ? JSON.stringify(message.metadata) : null,
            model: message.model ?? null,
            usage: message.usage ? JSON.stringify(message.usage) : null,
            estimatedTokens: message.estimatedTokens ?? null,
          });
        this.syncMessageFts(message.id, message.content);
        return true;
      }
      throw err;
    }
  }

  /** Standalone (non-"external content") FTS5 index, so kept in sync manually here rather than via triggers — delete-then-insert is simplest and correct for both a fresh row and an update-in-place. */
  private syncMessageFts(id: string, content: string): void {
    this.raw.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    this.raw.prepare('INSERT INTO messages_fts (content, message_id) VALUES (?, ?)').run(content, id);
  }

  getMessagesForThread(threadId: string, page?: { offset: number; limit: number }): Message[] {
    // Unpaginated by default because callers inside this file walk whole threads. The dashboard
    // passes a page: the largest real thread here is 13k messages averaging ~800 characters, so
    // serving one in full is a ~10MB response and thousands of DOM nodes for a single click.
    const rows = page
      ? (this.raw
          .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?')
          .all(threadId, page.limit, page.offset) as any[])
      : (this.raw
          .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence ASC')
          .all(threadId) as any[]);
    return rows.map(rowToMessage);
  }

  countMessagesForThread(threadId: string): number {
    const row = this.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(threadId) as { n: number };
    return row.n;
  }

  /**
   * The user's own turns in a thread, as jump targets for the dashboard's outline — the natural
   * structure of a conversation is "what was asked", so those are the anchors worth offering.
   * Deliberately excerpt-only (and a verbatim excerpt, never a generated summary): the point is to
   * stay small enough to load for a 13k-message thread when the messages themselves cannot.
   */
  getThreadOutline(threadId: string): { id: string; position: number; timestamp: string; excerpt: string }[] {
    // `position` is the 0-based index of that message within the whole thread, which is exactly
    // the offset the paginated endpoint takes — so clicking an outline entry can load the window
    // starting there instead of paging forward from the beginning to reach it.
    // Harness-injected turns carry role='user' but nobody typed them, so they make useless jump
    // targets. The list is explicit rather than "anything starting with <": real pasted content
    // in this store begins with <?xml, <!DOCTYPE, <t t-name=, <img … and must stay addressable.
    // Nothing is filtered out of the thread itself — only out of the list of anchors offered.
    const INJECTED_PREFIXES = [
      '<task-notification>',
      '<environment_context>',
      '<recommended_plugins>',
      '<uploaded_files>',
      '<local-command-stdout>',
      '<command-name>',
      '<command-message>',
      '<system-reminder>',
      '<local-command-caveat>',
      // Not a tag, but equally harness-written: the attachment manifest added when files are
      // dropped into a prompt. Matched in full so real pasted markdown starting with '#'
      // (#lang racket, # AGENTS.md …) keeps its anchor.
      '# Files mentioned by the user:',
    ];
    // ltrim(X) alone strips spaces only, and these blocks routinely open with a newline.
    const LEAD = "' ' || char(10) || char(13) || char(9)";
    const notInjected = INJECTED_PREFIXES.map(() => `ltrim(content, ${LEAD}) NOT LIKE ?`).join(' AND ');
    const rows = this.raw
      .prepare(
        `SELECT id, position, timestamp, excerpt FROM (
           SELECT id, role, timestamp,
                  ROW_NUMBER() OVER (ORDER BY sequence ASC) - 1 AS position,
                  trim(substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 160)) AS excerpt,
                  ${notInjected} AS keep
           FROM messages WHERE thread_id = ?
         ) WHERE role = 'user' AND keep AND excerpt <> '' ORDER BY position ASC`,
      )
      .all(...INJECTED_PREFIXES.map((prefix) => `${prefix}%`), threadId) as {
      id: string;
      position: number;
      timestamp: string;
      excerpt: string;
    }[];
    return rows;
  }

  /** The next page of messages this instance hasn't pushed to a remote hub yet, ordered by
   * ingest_seq — see backfillIngestSeq's doc for why that column exists instead of rowid/timestamp.
   * `maxSeq` is the watermark to pass back next call (0 unchanged when the page is empty). */
  getMessagesAfterSeq(afterSeq: number, limit: number): { messages: Message[]; maxSeq: number } {
    const rows = this.raw
      .prepare('SELECT * FROM messages WHERE ingest_seq > ? ORDER BY ingest_seq ASC LIMIT ?')
      .all(afterSeq, limit) as any[];
    const messages = rows.map(rowToMessage);
    const maxSeq = rows.length ? rows[rows.length - 1].ingest_seq : afterSeq;
    return { messages, maxSeq };
  }

  // --- remote sync (core/sync-push-client.ts & core/sync-pull-client.ts) --------------------

  /** How far this instance has pushed to and pulled from a given remote hub. */
  getRemoteSyncState(remoteUrl: string): RemoteSyncState {
    const row = this.raw.prepare('SELECT * FROM remote_sync_state WHERE remote_url = ?').get(remoteUrl) as any;
    return row
      ? {
          remoteUrl,
          lastPushedSeq: row.last_pushed_seq ?? 0,
          lastPushedAt: row.last_pushed_at ?? null,
          lastPulledSeq: row.last_pulled_seq ?? 0,
          lastPulledAt: row.last_pulled_at ?? null,
        }
      : {
          remoteUrl,
          lastPushedSeq: 0,
          lastPushedAt: null,
          lastPulledSeq: 0,
          lastPulledAt: null,
        };
  }

  setRemoteSyncState(remoteUrl: string, lastPushedSeq: number, lastPushedAt: string): void {
    this.raw
      .prepare(
        `INSERT INTO remote_sync_state (remote_url, last_pushed_seq, last_pushed_at) VALUES (?, ?, ?)
         ON CONFLICT(remote_url) DO UPDATE SET last_pushed_seq = excluded.last_pushed_seq, last_pushed_at = excluded.last_pushed_at`,
      )
      .run(remoteUrl, lastPushedSeq, lastPushedAt);
  }

  setRemoteSyncPullState(remoteUrl: string, lastPulledSeq: number, lastPulledAt: string): void {
    this.raw
      .prepare(
        `INSERT INTO remote_sync_state (remote_url, last_pulled_seq, last_pulled_at) VALUES (?, ?, ?)
         ON CONFLICT(remote_url) DO UPDATE SET last_pulled_seq = excluded.last_pulled_seq, last_pulled_at = excluded.last_pulled_at`,
      )
      .run(remoteUrl, lastPulledSeq, lastPulledAt);
  }

  /**
   * Produces a batch of data to pull by a secondary device/client, containing messages after `afterSeq`,
   * their referenced threads, and all current projects.
   */
  /**
   * One page of the hub's history for a pulling device, oldest first.
   *
   * `ownerUserId` scopes it to what that user may see. The window is taken *before* filtering, on
   * purpose: the watermark has to advance past messages the caller is not allowed to receive.
   * Filtering the query itself would return an empty page whenever the next `limit` messages all
   * belong to someone else, the caller's watermark would not move, and it would ask for the same
   * page forever.
   */
  getPullBatch(afterSeq: number, limit = 50, ownerUserId?: string): PullBatch {
    const rows = this.raw
      .prepare('SELECT * FROM messages WHERE ingest_seq > ? ORDER BY ingest_seq ASC LIMIT ?')
      .all(afterSeq, limit) as any[];
    // Scanned, not delivered — see above.
    const maxSeq = rows.length ? rows[rows.length - 1].ingest_seq : afterSeq;

    let visible = rows;
    let projects = this.getProjects();
    if (ownerUserId !== undefined) {
      const allowed = new Set(this.visibleProjectIds(ownerUserId));
      visible = rows.filter((r) => allowed.has(r.project_id));
      projects = projects.filter((p) => allowed.has(p.id));
    }

    const messages = visible.map(rowToMessage);
    const threadIds = [...new Set(messages.map((m) => m.threadId))];
    return {
      projects,
      threads: this.getThreadsByIds(threadIds),
      messages,
      maxSeq,
      hasMore: rows.length === limit,
    };
  }

  /**
   * Applies a batch pushed from a local instance (POST /api/sync/push) via the exact same
   * upsertProject/upsertThread/insertMessage this store already uses for its own local ingestion —
   * a remote hub is just this same schema, reached over the network instead of the filesystem.
   * Applied in FK dependency order (projects, then threads, then messages), each row in its own
   * try/catch: a single bad row (e.g. a canonical_path collision with a different project id —
   * plausible once multiple real machines contribute) is skipped along with anything that
   * depends on it, rather than rolling back or crashing on an otherwise-good batch.
   */
  applyRemoteBatch(batch: {
    projects: Project[];
    threads: Thread[];
    messages: Message[];
  }, ownerUserId?: string): {
    appliedProjects: number;
    appliedThreads: number;
    appliedMessages: number;
    skipped: { projects: string[]; threads: string[]; messages: string[] };
  } {
    const skippedProjectIds = new Set<string>();
    const skippedThreadIds = new Set<string>();
    const skipped = { projects: [] as string[], threads: [] as string[], messages: [] as string[] };
    let appliedProjects = 0;
    let appliedThreads = 0;
    let appliedMessages = 0;

    // Each row used to write in its own implicit transaction, so a 200-message batch cost 200
    // disk syncs and the push timed out against a real corpus. Wrapping the batch in one
    // transaction costs a single sync; nested transaction() calls in better-sqlite3 become
    // SAVEPOINTs, so `isolated` still rolls back only the row that failed and the rest applies.
    const isolated = this.raw.transaction((apply: () => void) => apply());

    const applyAll = this.raw.transaction(() => {
    for (const p of batch.projects) {
      try {
        // Ownership is taken from the credential that authenticated the push, never from the
        // payload: a device could otherwise claim a project belongs to somebody else.
        isolated(() => {
          this.upsertProject(p);
          if (ownerUserId) this.setProjectOwner(p.id, ownerUserId);
        });
        appliedProjects++;
      } catch (err: any) {
        skippedProjectIds.add(p.id);
        skipped.projects.push(p.id);
        console.error(`applyRemoteBatch: skipped project ${p.id}: ${err?.message ?? err}`);
      }
    }
    for (const t of batch.threads) {
      if (skippedProjectIds.has(t.projectId)) {
        skippedThreadIds.add(t.id);
        skipped.threads.push(t.id);
        continue;
      }
      try {
        isolated(() => this.upsertThread(t));
        appliedThreads++;
      } catch (err: any) {
        skippedThreadIds.add(t.id);
        skipped.threads.push(t.id);
        console.error(`applyRemoteBatch: skipped thread ${t.id}: ${err?.message ?? err}`);
      }
    }
    for (const m of batch.messages) {
      if (skippedThreadIds.has(m.threadId) || skippedProjectIds.has(m.projectId)) {
        skipped.messages.push(m.id);
        continue;
      }
      try {
        isolated(() => { this.insertMessage(m); }); // false = deduped by hash, still "handled", not a failure
        appliedMessages++;
      } catch (err: any) {
        skipped.messages.push(m.id);
        console.error(`applyRemoteBatch: skipped message ${m.id}: ${err?.message ?? err}`);
      }
    }
    });
    applyAll();
    return { appliedProjects, appliedThreads, appliedMessages, skipped };
  }

  /** Every message that carries real usage or token estimation — raw material for cost aggregation (see core/cost.ts). */
  getUsageRecords(scope: UsageScope = {}): UsageRecord[] {
    const real = this.getRealUsageRecords(scope);
    // Antigravity never reports real usage (verified: no token/model fields anywhere in its
    // transcript format) — estimated separately below rather than folded into the real-usage SQL,
    // since a proper estimate needs to walk each thread in order (see estimateAntigravityUsage).
    const estimated = !scope.engine || scope.engine === 'antigravity' ? this.estimateAntigravityUsage(scope) : [];
    const archived = this.estimateArchiveUsage(scope);
    return [...real, ...estimated, ...archived].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Archived Claude.ai / ChatGPT conversations, priced against the flagship model of their date.
   *
   * These exports carry neither usage nor model — 62k messages that scored nothing at all before
   * this. The tokens are counted (arithmetic, not a guess); the model is inferred from the app and
   * the date, which is a guess, and knowingly a high one. User turns count as input and assistant
   * turns as output: an export has no finer split, and the two rates differ by up to 6×, so
   * lumping them together would be worse than this.
   */
  private estimateArchiveUsage(scope: UsageScope): UsageRecord[] {
    if (scope.engine) return []; // no archive belongs to a single live engine
    let sql = `SELECT thread_id, project_id, source_engine, role, timestamp, estimated_tokens
               FROM messages
               WHERE usage IS NULL AND estimated_tokens IS NOT NULL
                 AND (thread_id LIKE 'chatgpt-export%' OR thread_id LIKE 'claude-export%')`;
    const params: string[] = [];
    if (scope.projectId) {
      sql += ' AND project_id = ?';
      params.push(scope.projectId);
    }
    if (scope.threadId) {
      sql += ' AND thread_id = ?';
      params.push(scope.threadId);
    }
    if (scope.startDate) {
      sql += ' AND timestamp >= ?';
      params.push(scope.startDate.includes('T') ? scope.startDate : `${scope.startDate}T00:00:00.000Z`);
    }
    if (scope.endDate) {
      sql += ' AND timestamp <= ?';
      params.push(scope.endDate.includes('T') ? scope.endDate : `${scope.endDate}T23:59:59.999Z`);
    }

    const records: UsageRecord[] = [];
    for (const row of this.raw.prepare(sql).all(...params) as any[]) {
      const provider = providerForThread(row.thread_id);
      if (!provider) continue;
      const model = modelForEra(provider, row.timestamp);
      if (!model) continue; // predates anything with a published rate — left uncounted, not invented
      const tokens = row.estimated_tokens as number;
      records.push({
        timestamp: row.timestamp,
        projectId: row.project_id,
        threadId: row.thread_id,
        sourceEngine: row.source_engine,
        model,
        usage:
          row.role === 'assistant'
            ? { inputTokens: 0, outputTokens: tokens }
            : { inputTokens: tokens, outputTokens: 0 },
        isEstimated: true,
        isInferredModel: true,
      });
    }
    return records;
  }

  /** Messages with a real, engine-reported model + token usage. */
  private getRealUsageRecords(scope: UsageScope): UsageRecord[] {
    let sql = `SELECT timestamp, project_id, thread_id, source_engine, model, usage FROM messages WHERE usage IS NOT NULL`;
    const params: string[] = [];
    if (scope.projectId) {
      sql += ' AND project_id = ?';
      params.push(scope.projectId);
    }
    if (scope.threadId) {
      sql += ' AND thread_id = ?';
      params.push(scope.threadId);
    }
    if (scope.engine) {
      sql += ' AND source_engine = ?';
      params.push(scope.engine);
    }
    if (scope.startDate) {
      sql += ' AND timestamp >= ?';
      params.push(scope.startDate.includes('T') ? scope.startDate : `${scope.startDate}T00:00:00.000Z`);
    }
    if (scope.endDate) {
      sql += ' AND timestamp <= ?';
      params.push(scope.endDate.includes('T') ? scope.endDate : `${scope.endDate}T23:59:59.999Z`);
    }
    const rows = this.raw.prepare(sql).all(...params) as any[];
    // A message can carry usage with no model (e.g. an edge case in an adapter's own parsing) —
    // left as undefined rather than guessed at a specific paid model: estimateCostUsd treats a
    // missing model as unpriced, which is correct here, not silently priced as if it were real.
    return rows.map((r) => ({
      timestamp: r.timestamp,
      projectId: r.project_id,
      threadId: r.thread_id,
      sourceEngine: r.source_engine as EngineType,
      model: r.model ?? undefined,
      usage: JSON.parse(r.usage) as TokenUsage,
      isEstimated: false,
    }));
  }

  /**
   * Antigravity's transcript carries no token/model fields at all (verified against the real
   * format), so this estimates from text length using a real BPE tokenizer (gpt-tokenizer,
   * OpenAI's o200k_base encoding — not Gemini's own, which isn't public, but a far closer proxy
   * than a flat chars-per-token divisor) rather than guessing a number outright. Every field here
   * is estimated and every record is marked isEstimated — never silently blended with real usage.
   *
   * A single API turn's real input cost is the FULL prior conversation, not just the latest
   * message — modeled by walking each thread in sequence and tracking a running token count:
   * input for an assistant turn = the sum of every prior message's own token count in that
   * thread (system context, prior turns, tool results all included); output = that turn's own
   * content + thought + tool call/result payloads. Each message's own token count is computed
   * ONCE, at ingest time (messages.estimated_tokens — see antigravity.ts), not here: re-tokenizing
   * the whole corpus on every /api/costs call measured at ~2s on the real ~6,500-message
   * Antigravity history, which is far too slow to pay on every request just to add up numbers that
   * never change once a message exists. This method is now just a cheap running sum.
   */
  private estimateAntigravityUsage(scope: UsageScope): UsageRecord[] {
    let sql = `SELECT thread_id, project_id, role, content, thought, tool_calls, tool_results, timestamp, estimated_tokens
               FROM messages WHERE source_engine = 'antigravity'`;
    const params: string[] = [];
    if (scope.projectId) {
      sql += ' AND project_id = ?';
      params.push(scope.projectId);
    }
    if (scope.threadId) {
      sql += ' AND thread_id = ?';
      params.push(scope.threadId);
    }
    sql += ' ORDER BY thread_id, sequence ASC';
    const rows = this.raw.prepare(sql).all(...params) as any[];

    const startBound = scope.startDate ? (scope.startDate.includes('T') ? scope.startDate : `${scope.startDate}T00:00:00.000Z`) : undefined;
    const endBound = scope.endDate ? (scope.endDate.includes('T') ? scope.endDate : `${scope.endDate}T23:59:59.999Z`) : undefined;

    const records: UsageRecord[] = [];
    let currentThreadId: string | null = null;
    let contextTokens = 0;
    for (const row of rows) {
      if (row.thread_id !== currentThreadId) {
        currentThreadId = row.thread_id;
        contextTokens = 0;
      }
      // Defensive fallback only — every row should have this populated by ingest-time computation
      // plus the constructor's one-time backfill; never re-tokenize the whole scope's worth just
      // because one row's column happens to be null.
      const ownTokens =
        row.estimated_tokens ??
        (() => {
          const ownText = [row.content, row.thought, row.tool_calls, row.tool_results].filter(Boolean).join('\n');
          return ownText ? encode(ownText).length : 0;
        })();

      if (row.role === 'assistant' && ownTokens > 0) {
        const inBounds = (!startBound || row.timestamp >= startBound) && (!endBound || row.timestamp <= endBound);
        if (inBounds) {
          records.push({
            timestamp: row.timestamp,
            projectId: row.project_id,
            threadId: row.thread_id,
            sourceEngine: 'antigravity',
            model: 'gemini-2.5-pro',
            usage: { inputTokens: contextTokens, outputTokens: ownTokens },
            isEstimated: true,
          });
        }
      }
      contextTokens += ownTokens;
    }
    return records;
  }

  /** Verbatim cross-tool timeline for a project, optionally since a given ISO timestamp. Backs the MCP server. */
  getProjectTimeline(projectId: string, since?: string): Message[] {
    const rows = since
      ? (this.raw
          .prepare('SELECT * FROM messages WHERE project_id = ? AND timestamp > ? ORDER BY timestamp ASC')
          .all(projectId, since) as any[])
      : (this.raw
          .prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY timestamp ASC')
          .all(projectId) as any[]);
    return rows.map(rowToMessage);
  }

  /**
   * Common short French function words — excluded from the AND clause because their near-zero
   * selectivity is actively harmful, not just unhelpful: a query containing "à" alone can make
   * the content match fill its entire `limit` with messages that just happen to contain "à" plus
   * every other word somewhere, unrelated to what was actually meant — which then starved out the
   * title fallback below entirely (a real find: searching the exact real title "Processus mise à
   * jour Ekonum" returned 50 coincidental content hits and never got to check titles, even though
   * the target thread's title matched exactly). Filtered independently for content and title
   * matching; if filtering empties the word list (e.g. the query was only stopwords), the
   * original words are used as-is rather than matching everything.
   */
  private static STOPWORDS = new Set([
    'à', 'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'en', 'au', 'aux', 'ce', 'se', 'sa', 'son',
    'ses', 'que', 'qui', 'sur', 'pour', 'dans', 'par', 'est', 'sont', 'on', 'tu', 'il', 'elle', 'ne', 'pas', 'ça',
    'ces', 'cet', 'cette', 'avec', 'sans',
  ]);

  private static significantWords(query: string): string[] {
    const words = query.trim().split(/\s+/).filter(Boolean);
    const significant = words.filter((w) => w.length >= 2 && !Db.STOPWORDS.has(w.toLowerCase()));
    return significant.length > 0 ? significant : words;
  }

  /** Wraps text as one FTS5 phrase token — doubling embedded `"` is the only escaping FTS5's
   * query syntax needs, and quoting sidesteps every other special character (hyphens, colons,
   * reserved words like AND/OR/NOT/NEAR) being parsed as an operator instead of literal text. */
  private static ftsPhrase(text: string): string {
    return `"${text.replace(/"/g, '""')}"`;
  }

  /** Space-separated quoted-prefix tokens are implicitly ANDed by FTS5 — the tokenized,
   * relevance-ranked equivalent of the old "every word present somewhere" LIKE matching. The
   * trailing `*` (FTS5 prefix-query syntax, valid on a quoted phrase) restores the substring-like
   * leniency plain LIKE had for free — a real regression without it: "mise" as an exact token
   * stopped matching "mises" (FTS5 has no stemming, so a bare exact-token match is stricter than
   * `LIKE '%mise%'` ever was for ordinary singular/plural and conjugation variants). */
  private static ftsAndQuery(words: string[]): string {
    return words.map((w) => `${Db.ftsPhrase(w)}*`).join(' ');
  }

  /**
   * Two real complaints drove this design: pasting a thread's exact title often didn't find it,
   * and a sentence known to be unique got buried among many loosely-related results. Both traced
   * to the same root cause — plain substring/LIKE matching has no notion of relevance, so an exact
   * match ranked no higher than a coincidental one, and ordering was by recency alone.
   *
   * Now runs FTS5 MATCH queries in four tiers, filling `limit` in order and never letting a lower
   * tier touch a thread a higher tier already placed:
   *   1. title, exact phrase   2. content, exact phrase (bm25-ranked, capped per thread)
   *   3. title, AND-of-words   4. content, AND-of-words (bm25-ranked, capped per thread)
   * An exact phrase — the strongest, most deliberate signal (a pasted title, a sentence known to
   * be unique) — is tried before any looser word-scatter matching gets a chance to bury it, and
   * bm25 relevance replaces plain recency ordering for the fallback tiers. remove_diacritics on
   * both FTS5 tables (see SCHEMA) also means "a" now matches "à", unlike the old LIKE approach.
   * Still requires each word's exact spelling: "processus" won't match "process" (no stemming).
   */
  searchTranscripts(query: string, limit = 50): Message[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const words = Db.significantWords(trimmed);
    const phraseQuery = Db.ftsPhrase(trimmed);
    const andQuery = words.length > 0 ? Db.ftsAndQuery(words) : null;

    const results: Message[] = [];
    const titledThreadIds = new Set<string>();
    const contentCounts = new Map<string, number>();
    const seenMessageIds = new Set<string>();
    const MAX_CONTENT_PER_THREAD = 3;

    const addTitleMatches = (matchQuery: string) => {
      if (results.length >= limit) return;
      let rows: { thread_id: string }[];
      try {
        rows = this.raw
          .prepare('SELECT thread_id FROM threads_fts WHERE threads_fts MATCH ? ORDER BY bm25(threads_fts) LIMIT ?')
          .all(matchQuery, limit) as { thread_id: string }[];
      } catch {
        return; // a malformed FTS5 query should never crash a search — just contributes nothing
      }
      for (const { thread_id: threadId } of rows) {
        if (results.length >= limit) break;
        if (titledThreadIds.has(threadId) || contentCounts.has(threadId)) continue;
        titledThreadIds.add(threadId);
        const messages = this.getMessagesForThread(threadId);
        const representative = messages.find((m) => m.role === 'user') ?? messages[0];
        if (representative) results.push(representative);
      }
    };

    const addContentMatches = (matchQuery: string) => {
      if (results.length >= limit) return;
      let rows: any[];
      try {
        rows = this.raw
          .prepare(
            `SELECT m.* FROM messages m JOIN messages_fts ON messages_fts.message_id = m.id
             WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
          )
          .all(matchQuery, Math.min(limit * 10, 2000)) as any[];
      } catch {
        return;
      }
      for (const row of rows) {
        if (results.length >= limit) break;
        const message = rowToMessage(row);
        // The same message can satisfy both the phrase tier and the AND-of-words tier (a phrase
        // match trivially also satisfies "every word present") — without this, it could be
        // pushed into results twice, since the per-thread count alone doesn't dedupe by message.
        if (seenMessageIds.has(message.id)) continue;
        if (titledThreadIds.has(message.threadId)) continue;
        const count = contentCounts.get(message.threadId) ?? 0;
        if (count >= MAX_CONTENT_PER_THREAD) continue;
        contentCounts.set(message.threadId, count + 1);
        seenMessageIds.add(message.id);
        results.push(message);
      }
    };

    addTitleMatches(phraseQuery);
    addContentMatches(phraseQuery);
    if (andQuery) {
      addTitleMatches(andQuery);
      addContentMatches(andQuery);
    }

    return results;
  }

  // --- memories & artifacts -------------------------------------------------

  upsertMemory(memory: Memory): void {
    this.raw
      .prepare(
        `INSERT INTO memories (id, project_id, source_engine, category, file_path, content, last_modified_at)
         VALUES (@id, @projectId, @sourceEngine, @category, @filePath, @content, @lastModifiedAt)
         ON CONFLICT(file_path) DO UPDATE SET
           content = excluded.content,
           last_modified_at = excluded.last_modified_at,
           category = excluded.category`,
      )
      .run({
        id: memory.id,
        projectId: memory.projectId,
        sourceEngine: memory.sourceEngine,
        category: memory.category,
        filePath: memory.filePath,
        content: memory.content,
        lastModifiedAt: memory.lastModifiedAt,
      });
  }

  getMemoriesForProject(projectId: string): Memory[] {
    const rows = this.raw.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY last_modified_at DESC').all(projectId) as any[];
    return rows.map(rowToMemory);
  }

  upsertArtifact(artifact: Artifact): void {
    this.raw
      .prepare(
        `INSERT INTO artifacts (id, project_id, thread_id, title, file_path, type, content, source_engine, created_at)
         VALUES (@id, @projectId, @threadId, @title, @filePath, @type, @content, @sourceEngine, @createdAt)
         ON CONFLICT(file_path) DO UPDATE SET
           content = excluded.content,
           title = excluded.title`,
      )
      .run({
        id: artifact.id,
        projectId: artifact.projectId,
        threadId: artifact.threadId ?? null,
        title: artifact.title,
        filePath: artifact.filePath,
        type: artifact.type,
        content: artifact.content,
        sourceEngine: artifact.sourceEngine,
        createdAt: artifact.createdAt,
      });
  }

  getArtifactsForProject(projectId: string): Artifact[] {
    const rows = this.raw.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[];
    return rows.map(rowToArtifact);
  }

  // --- ingest log -----------------------------------------------------------

  logIngestEvent(entry: IngestLogEntry): void {
    this.raw
      .prepare(
        `INSERT INTO ingest_log (engine, file_path, event_type, status, message, timestamp)
         VALUES (@engine, @filePath, @eventType, @status, @message, @timestamp)`,
      )
      .run({
        engine: entry.engine,
        filePath: entry.filePath,
        eventType: entry.eventType,
        status: entry.status,
        message: entry.message ?? null,
        timestamp: entry.timestamp,
      });
  }

  getLastIngestAt(engine: EngineType): string | null {
    const row = this.raw
      .prepare("SELECT timestamp FROM ingest_log WHERE engine = ? AND status != 'error' ORDER BY timestamp DESC LIMIT 1")
      .get(engine) as any;
    return row?.timestamp ?? null;
  }

  // --- MCP call log -------------------------------------------------------

  /** Records one MCP tool invocation — verbatim params + a short outcome summary, for after-the-fact debugging. */
  logMcpCall(tool: string, params: unknown, isError: boolean, summary: string | undefined, timestamp: string): void {
    this.raw
      .prepare('INSERT INTO mcp_call_log (tool, params, is_error, summary, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(tool, JSON.stringify(params), isError ? 1 : 0, summary ?? null, timestamp);
  }

  /** Most recent MCP calls, newest first — optionally filtered to one tool. */
  getRecentMcpCalls(limit = 100, tool?: string): McpCallLogEntry[] {
    const rows = (
      tool
        ? this.raw.prepare('SELECT * FROM mcp_call_log WHERE tool = ? ORDER BY id DESC LIMIT ?').all(tool, limit)
        : this.raw.prepare('SELECT * FROM mcp_call_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as any[];
    return rows.map((row) => ({
      id: row.id,
      tool: row.tool,
      params: JSON.parse(row.params),
      isError: !!row.is_error,
      summary: row.summary ?? undefined,
      timestamp: row.timestamp,
    }));
  }

  /** Most recent message timestamp per engine, for one project — backs the pointer-file summary. */
  getLastActivityByEngine(projectId: string): Partial<Record<EngineType, string>> {
    const rows = this.raw
      .prepare('SELECT source_engine, MAX(timestamp) as last FROM messages WHERE project_id = ? GROUP BY source_engine')
      .all(projectId) as any[];
    const out: Partial<Record<EngineType, string>> = {};
    for (const row of rows) out[row.source_engine as EngineType] = row.last;
    return out;
  }

  // --- aggregate stats --------------------------------------------------

  countMessagesForEngine(engine: EngineType): number {
    const row = this.raw.prepare('SELECT COUNT(*) as n FROM messages WHERE source_engine = ?').get(engine) as any;
    return row?.n ?? 0;
  }

  countAll(table: 'projects' | 'threads' | 'messages' | 'memories' | 'artifacts'): number {
    const row = this.raw.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as any;
    return row?.n ?? 0;
  }

  countThreadsForProject(projectId: string, status?: string): number {
    const row = status
      ? (this.raw.prepare('SELECT COUNT(*) as n FROM threads WHERE project_id = ? AND status = ?').get(projectId, status) as any)
      : (this.raw.prepare('SELECT COUNT(*) as n FROM threads WHERE project_id = ?').get(projectId) as any);
    return row?.n ?? 0;
  }

  // --- Users & Authentication ---

  createUser(user: { id?: string; email: string; displayName: string; passwordHash: string; role?: UserRole }): User {
    const id = user.id ?? randomUUID();
    const now = new Date().toISOString();
    const role: UserRole = user.role ?? 'member';
    const email = user.email.trim().toLowerCase();
    this.raw.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, user.displayName.trim(), user.passwordHash, role, now, now);
    return { id, email, displayName: user.displayName.trim(), role, createdAt: now, updatedAt: now };
  }

  getUserById(id: string): User | undefined {
    const row = this.raw.prepare(`SELECT id, email, display_name, role, created_at, updated_at FROM users WHERE id = ?`).get(id);
    return row ? rowToUser(row) : undefined;
  }

  getUserByEmail(email: string): UserWithPasswordHash | undefined {
    const row = this.raw.prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim().toLowerCase());
    return row ? rowToUserWithPasswordHash(row) : undefined;
  }

  listUsers(): User[] {
    const rows = this.raw.prepare(`SELECT id, email, display_name, role, created_at, updated_at FROM users ORDER BY created_at ASC`).all();
    return rows.map(rowToUser);
  }

  updateUser(id: string, updates: { email?: string; displayName?: string; passwordHash?: string; role?: UserRole }): User | undefined {
    const existing = this.getUserById(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const email = updates.email !== undefined ? updates.email.trim().toLowerCase() : existing.email;
    const displayName = updates.displayName !== undefined ? updates.displayName.trim() : existing.displayName;
    const role = updates.role !== undefined ? updates.role : existing.role;

    if (updates.passwordHash !== undefined) {
      this.raw.prepare(`
        UPDATE users SET email = ?, display_name = ?, password_hash = ?, role = ?, updated_at = ? WHERE id = ?
      `).run(email, displayName, updates.passwordHash, role, now, id);
    } else {
      this.raw.prepare(`
        UPDATE users SET email = ?, display_name = ?, role = ?, updated_at = ? WHERE id = ?
      `).run(email, displayName, role, now, id);
    }
    return { id, email, displayName, role, createdAt: existing.createdAt, updatedAt: now };
  }

  deleteUser(id: string): boolean {
    const res = this.raw.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  countUsers(): number {
    const row = this.raw.prepare(`SELECT COUNT(*) as count FROM users`).get() as { count: number };
    return row.count;
  }

  // --- Sessions ---

  createSession(session: { id?: string; userId: string; tokenHash: string; expiresAt: string; userAgent?: string; ip?: string }): Session {
    const id = session.id ?? randomUUID();
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, session.userId, session.tokenHash, session.expiresAt, now, session.userAgent ?? null, session.ip ?? null);
    return {
      id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      createdAt: now,
      userAgent: session.userAgent,
      ip: session.ip,
    };
  }

  getSessionByTokenHash(tokenHash: string): { session: Session; user: User } | undefined {
    const now = new Date().toISOString();
    const row = this.raw.prepare(`
      SELECT s.id as s_id, s.user_id, s.token_hash, s.expires_at, s.created_at as s_created_at, s.user_agent, s.ip,
             u.id as u_id, u.email, u.display_name, u.role, u.created_at as u_created_at, u.updated_at as u_updated_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, now) as any;

    if (!row) return undefined;
    return {
      session: {
        id: row.s_id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        createdAt: row.s_created_at,
        userAgent: row.user_agent ?? undefined,
        ip: row.ip ?? undefined,
      },
      user: {
        id: row.u_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        createdAt: row.u_created_at,
        updatedAt: row.u_updated_at,
      },
    };
  }

  /**
   * Adopts ownerless projects when the store has exactly one account.
   *
   * /api/auth/setup adopts on the way in, but that only helps an instance whose admin is created
   * after this code ships. The deployed hub got its admin while ownership did not exist yet, so
   * its projects carry no owner and — now that reads filter — would be invisible to the very
   * person who owns the machine.
   *
   * Guarded on exactly one user: with a single account there is no ambiguity about whose data
   * predates multi-user. With two or more, adopting would be a guess, and this does nothing.
   */
  private adoptOrphanProjectsOnSingleUserStore(): void {
    const users = this.raw.prepare(`SELECT id FROM users LIMIT 2`).all() as { id: string }[];
    if (users.length !== 1) return;
    const adopted = this.adoptOrphanProjects(users[0].id);
    if (adopted > 0) console.log(`sync-hub: ${adopted} projet(s) sans propriétaire attribués au seul compte existant`);
  }

  /**
   * Hands every ownerless project to a user. Called when the first admin account is created: the
   * store already holds everything ingested before accounts existed (63 projects here), and
   * leaving those rows unowned would make them invisible the moment reads start filtering.
   * Idempotent — later calls match nothing.
   */
  /**
   * The oldest admin account, which is the person who set this instance up. Used to give the
   * legacy shared token a real identity: a synthetic user cannot own a project (owner_user_id is
   * a foreign key), and applyRemoteBatch skips a row whose insert fails — so a push authenticated
   * that way would answer 200 while silently storing nothing.
   */
  getPrimaryAdmin(): User | undefined {
    const row = this.raw
      .prepare(`SELECT id, email, display_name, role, created_at, updated_at FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`)
      .get() as any;
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  adoptOrphanProjects(userId: string): number {
    return this.raw.prepare(`UPDATE projects SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(userId).changes;
  }

  setProjectOwner(projectId: string, userId: string): boolean {
    return this.raw.prepare(`UPDATE projects SET owner_user_id = ? WHERE id = ?`).run(userId, projectId).changes > 0;
  }

  /**
   * The projects a user may read: their own. Shares land here in phase 3 — kept as one function
   * so every read path gains them at once rather than each growing its own half-right condition.
   */
  visibleProjectIds(userId: string): string[] {
    const rows = this.raw
      .prepare(
        `SELECT id FROM projects WHERE owner_user_id = ?
         UNION
         SELECT project_id FROM project_shares WHERE user_id = ?`,
      )
      .all(userId, userId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** True when the user owns the project or it has been shared with them. */
  canReadProject(userId: string, projectId: string): boolean {
    const row = this.raw
      .prepare(
        `SELECT 1 AS ok FROM projects WHERE id = ? AND owner_user_id = ?
         UNION
         SELECT 1 AS ok FROM project_shares WHERE project_id = ? AND user_id = ?
         LIMIT 1`,
      )
      .get(projectId, userId, projectId, userId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /** Only the owner may hand a project out — a share does not confer the right to re-share. */
  ownsProject(userId: string, projectId: string): boolean {
    const row = this.raw.prepare(`SELECT 1 AS ok FROM projects WHERE id = ? AND owner_user_id = ?`).get(projectId, userId) as
      | { ok: number }
      | undefined;
    return row !== undefined;
  }

  shareProject(projectId: string, userId: string, createdByUserId: string, permission: 'read' | 'write' = 'read'): void {
    this.raw
      .prepare(
        `INSERT INTO project_shares (project_id, user_id, permission, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`,
      )
      .run(projectId, userId, permission, new Date().toISOString(), createdByUserId);
  }

  unshareProject(projectId: string, userId: string): boolean {
    return this.raw.prepare(`DELETE FROM project_shares WHERE project_id = ? AND user_id = ?`).run(projectId, userId).changes > 0;
  }

  listProjectShares(projectId: string): { userId: string; email: string; displayName: string; permission: string; createdAt: string }[] {
    const rows = this.raw
      .prepare(
        `SELECT s.user_id, u.email, u.display_name, s.permission, s.created_at
         FROM project_shares s JOIN users u ON u.id = s.user_id
         WHERE s.project_id = ? ORDER BY u.display_name`,
      )
      .all(projectId) as any[];
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      permission: r.permission,
      createdAt: r.created_at,
    }));
  }

  /**
   * Walks the corpus looking for credentials, grouped by the secret itself rather than by message.
   *
   * Grouped because the same token typically appears dozens of times — 995 occurrences across 19
   * distinct values on this store — and a reviewer decides about a credential once, not once per
   * message. Read-only: nothing is changed until redactSecret is called with an explicit value.
   */
  async scanForSecrets(onProgress?: (scanned: number) => void): Promise<SecretScanResult[]> {
    // Paged rather than iterated. better-sqlite3 keeps the connection busy for the whole life of
    // an iterator, so yielding mid-iteration lets ingestion hit the same connection and throw
    // "database connection is busy" — which crashed the daemon outright when it happened here.
    // A page is a query that finishes before we hand the loop back.
    const PAGE = 500;
    const page = this.raw.prepare(
      `SELECT rowid AS rid, id, content, thought, tool_calls, tool_results FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    const groups = new Map<string, SecretScanResult>();

    let scanned = 0;
    let cursor = 0;
    for (;;) {
      const rows = page.all(cursor, PAGE) as any[];
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].rid;

      for (const row of rows) {
        scanned++;
        for (const [field, text] of [
        ['content', row.content],
        ['thought', row.thought],
        ['tool_calls', row.tool_calls],
        ['tool_results', row.tool_results],
      ] as const) {
        if (!text) continue;
        for (const finding of scanText(text)) {
          const existing = groups.get(finding.value);
          if (existing) {
            existing.occurrences++;
            if (!existing.messageIds.includes(row.id) && existing.messageIds.length < 200) existing.messageIds.push(row.id);
            continue;
          }
          groups.set(finding.value, {
            masked: maskSecret(finding.value),
            kind: finding.kind,
            confidence: finding.confidence,
            occurrences: 1,
            messageIds: [row.id],
            // Enough surrounding text to judge, with the secret itself masked out: a review screen
            // that reprints credentials in full has simply moved the leak somewhere else.
            sample: maskEverySecret(text.slice(Math.max(0, finding.start - 60), finding.end + 30), finding.value)
              .replace(/\s+/g, ' ')
              .trim(),
            field,
          });
          }
        }
      }

      // Thirteen patterns over hundreds of megabytes is minutes of CPU on one thread. Without
      // this the dashboard is frozen for the duration — measured at 180s on this store.
      onProgress?.(scanned);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    return [...groups.values()].sort(
      (a, b) => (a.confidence === b.confidence ? b.occurrences - a.occurrences : a.confidence === 'certain' ? -1 : 1),
    );
  }

  /**
   * Replaces one credential everywhere it appears, across every field and the search index.
   *
   * Takes the literal value rather than a finding id: the caller already holds it, and matching on
   * the value is what guarantees no occurrence is missed because a scan went stale in between.
   * Irreversible by design — the point is that the secret stops existing here.
   */
  redactSecret(value: string): { messagesChanged: number; occurrences: number } {
    if (!value) return { messagesChanged: 0, occurrences: 0 };
    const rows = this.raw
      .prepare(
        `SELECT id, content, thought, tool_calls, tool_results FROM messages
         WHERE instr(COALESCE(content,''), ?) > 0 OR instr(COALESCE(thought,''), ?) > 0
            OR instr(COALESCE(tool_calls,''), ?) > 0 OR instr(COALESCE(tool_results,''), ?) > 0`,
      )
      .all(value, value, value, value) as any[];

    let messagesChanged = 0;
    let occurrences = 0;
    const update = this.raw.prepare(
      `UPDATE messages SET content = ?, thought = ?, tool_calls = ?, tool_results = ? WHERE id = ?`,
    );

    this.raw.transaction(() => {
      for (const row of rows) {
        const replaced = ['content', 'thought', 'tool_calls', 'tool_results'].map((field) => {
          const text: string | null = row[field];
          if (!text || !text.includes(value)) return text;
          occurrences += text.split(value).length - 1;
          return text.split(value).join('[secret retiré]');
        });
        update.run(replaced[0], replaced[1], replaced[2], replaced[3], row.id);
        // The search index holds its own copy of the content — leaving it would keep the secret
        // findable by typing it into the search box.
        this.syncMessageFts(row.id, (replaced[0] as string | null) ?? '');
        messagesChanged++;
      }
    })();

    return { messagesChanged, occurrences };
  }

  createApiToken(token: { id?: string; userId: string; tokenHash: string; name: string }): ApiToken {
    const id = token.id ?? randomUUID();
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO api_tokens (id, user_id, token_hash, name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, token.userId, token.tokenHash, token.name, now);
    return { id, userId: token.userId, tokenHash: token.tokenHash, name: token.name, createdAt: now };
  }

  /**
   * Resolves a machine token to its owner, or undefined if it is unknown or revoked. Also stamps
   * last_used_at, which is what makes an unused-since-months token identifiable when cleaning up.
   */
  getUserByApiToken(tokenHash: string): User | undefined {
    const row = this.raw.prepare(`
      SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.updated_at
      FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
    `).get(tokenHash) as any;
    if (!row) return undefined;
    this.raw.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`).run(new Date().toISOString(), tokenHash);
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listApiTokens(userId: string): ApiToken[] {
    const rows = this.raw.prepare(`
      SELECT id, user_id, token_hash, name, created_at, last_used_at, revoked_at
      FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId) as any[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      tokenHash: r.token_hash,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? undefined,
      revokedAt: r.revoked_at ?? undefined,
    }));
  }

  /** Revoked rather than deleted, so a token that turns up in a log stays identifiable afterwards. */
  revokeApiToken(id: string, userId: string): boolean {
    const res = this.raw
      .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), id, userId);
    return res.changes > 0;
  }

  deleteSessionByTokenHash(tokenHash: string): boolean {
    const res = this.raw.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return res.changes > 0;
  }

  deleteSessionsForUser(userId: string): number {
    const res = this.raw.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    return res.changes;
  }

  cleanExpiredSessions(): number {
    const now = new Date().toISOString();
    const res = this.raw.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
    return res.changes;
  }

  // --- Shared Threads ---

  createSharedThread(input: CreateSharedThreadInput, createdByUserId?: string | null): SharedThread {
    const id = randomUUID();
    const shareToken = randomBytes(24).toString('base64url');
    const now = new Date().toISOString();
    const title = input.title?.trim() || null;
    const expiresAt = input.expiresAt || null;

    this.raw.prepare(`
      INSERT INTO shared_threads (id, thread_id, share_token, created_by_user_id, title, is_active, expires_at, view_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).run(id, input.threadId, shareToken, createdByUserId ?? null, title, expiresAt, now, now);

    return {
      id,
      threadId: input.threadId,
      shareToken,
      createdByUserId: createdByUserId ?? null,
      title,
      isActive: true,
      expiresAt,
      viewCount: 0,
      lastViewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getSharedThreadByToken(shareToken: string, options?: { allowInactive?: boolean; allowExpired?: boolean }): SharedThread | undefined {
    const row = this.raw.prepare(`SELECT * FROM shared_threads WHERE share_token = ?`).get(shareToken) as any;
    if (!row) return undefined;
    const item = rowToSharedThread(row);
    if (!options?.allowInactive && !item.isActive) return undefined;
    if (!options?.allowExpired && item.expiresAt && new Date(item.expiresAt) <= new Date()) return undefined;
    return item;
  }

  getSharedThreadById(id: string): SharedThread | undefined {
    const row = this.raw.prepare(`SELECT * FROM shared_threads WHERE id = ?`).get(id) as any;
    return row ? rowToSharedThread(row) : undefined;
  }

  listSharedThreadsForThread(threadId: string): SharedThread[] {
    const rows = this.raw.prepare(`SELECT * FROM shared_threads WHERE thread_id = ? ORDER BY created_at DESC`).all(threadId) as any[];
    return rows.map(rowToSharedThread);
  }

  listSharedThreads(createdByUserId?: string): SharedThread[] {
    if (createdByUserId) {
      const rows = this.raw.prepare(`SELECT * FROM shared_threads WHERE created_by_user_id = ? ORDER BY created_at DESC`).all(createdByUserId) as any[];
      return rows.map(rowToSharedThread);
    }
    const rows = this.raw.prepare(`SELECT * FROM shared_threads ORDER BY created_at DESC`).all() as any[];
    return rows.map(rowToSharedThread);
  }

  updateSharedThread(id: string, updates: UpdateSharedThreadInput): SharedThread | undefined {
    const existing = this.getSharedThreadById(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const title = updates.title !== undefined ? (updates.title?.trim() || null) : existing.title;
    const isActive = updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : (existing.isActive ? 1 : 0);
    const expiresAt = updates.expiresAt !== undefined ? (updates.expiresAt || null) : existing.expiresAt;

    this.raw.prepare(`
      UPDATE shared_threads SET title = ?, is_active = ?, expires_at = ?, updated_at = ? WHERE id = ?
    `).run(title, isActive, expiresAt, now, id);

    return {
      ...existing,
      title,
      isActive: Boolean(isActive),
      expiresAt,
      updatedAt: now,
    };
  }

  deleteSharedThread(id: string): boolean {
    const res = this.raw.prepare(`DELETE FROM shared_threads WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  incrementSharedThreadViewCount(shareToken: string): void {
    const now = new Date().toISOString();
    this.raw.prepare(`
      UPDATE shared_threads SET view_count = view_count + 1, last_viewed_at = ? WHERE share_token = ?
    `).run(now, shareToken);
  }

  getEngineStats(): EngineStats[] {
    const rows = this.raw.prepare(`
      SELECT 
        source_engine as engine,
        COUNT(DISTINCT id) as message_count,
        COUNT(DISTINCT thread_id) as thread_count,
        MAX(timestamp) as last_active_at
      FROM messages
      GROUP BY source_engine
      ORDER BY message_count DESC
    `).all() as Array<{ engine: string; message_count: number; thread_count: number; last_active_at: string | null }>;

    const engineLabels: Record<string, string> = {
      'claude-code': 'Claude Code',
      codex: 'Codex / ChatGPT',
      antigravity: 'Antigravity',
      cowork: 'Cowork',
    };

    return rows.map((r) => ({
      engine: r.engine as EngineType,
      label: engineLabels[r.engine] ?? r.engine,
      messageCount: r.message_count,
      threadCount: r.thread_count,
      lastActiveAt: r.last_active_at,
    }));
  }

  getSyncOverview(remoteUrl?: string): SyncOverview {
    const users = this.listUsers();
    const nowIso = new Date().toISOString();

    const accounts: AccountSyncOverview[] = users.map((u: User) => {
      const sessionRows = this.raw.prepare(`
        SELECT id, user_id, user_agent, ip, created_at, expires_at
        FROM sessions
        WHERE user_id = ? AND expires_at > ?
        ORDER BY created_at DESC
      `).all(u.id, nowIso) as Array<{
        id: string;
        user_id: string;
        user_agent?: string;
        ip?: string;
        created_at: string;
        expires_at: string;
      }>;

      const devices: DeviceSession[] = sessionRows.map((s) => ({
        id: s.id,
        userId: s.user_id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        deviceLabel: parseDeviceLabel(s.user_agent),
      }));

      return {
        user: u,
        devices,
      };
    });

    const engines = this.getEngineStats();
    const syncState = remoteUrl ? this.getRemoteSyncState(remoteUrl) : null;

    const totalProjects = (this.raw.prepare(`SELECT count(*) as c FROM projects WHERE id != '__unassigned__' AND id != 'unassigned'`).get() as { c: number }).c;
    const totalThreads = (this.raw.prepare(`SELECT count(*) as c FROM threads`).get() as { c: number }).c;
    const totalMessages = (this.raw.prepare(`SELECT count(*) as c FROM messages`).get() as { c: number }).c;

    return {
      remoteConfigured: !!(remoteUrl && syncState),
      remoteUrl: remoteUrl ?? null,
      syncState,
      accounts,
      engines,
      totalProjects,
      totalThreads,
      totalMessages,
    };
  }
}

function parseDeviceLabel(userAgent?: string): string {
  if (!userAgent) return 'Navigateur Web';
  const ua = userAgent.toLowerCase();
  if (ua.includes('macintosh') || ua.includes('mac os x')) return 'MacBook / macOS';
  if (ua.includes('windows')) return 'PC Windows';
  if (ua.includes('iphone')) return 'iPhone (iOS)';
  if (ua.includes('ipad')) return 'iPad (iPadOS)';
  if (ua.includes('android')) return 'Smartphone Android';
  if (ua.includes('linux')) return 'Machine Linux';
  return 'Navigateur Web';
}

function rowToSharedThread(row: any): SharedThread {
  return {
    id: row.id,
    threadId: row.thread_id,
    shareToken: row.share_token,
    createdByUserId: row.created_by_user_id ?? null,
    title: row.title ?? null,
    isActive: Boolean(row.is_active),
    expiresAt: row.expires_at ?? null,
    viewCount: row.view_count ?? 0,
    lastViewedAt: row.last_viewed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as UserRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUserWithPasswordHash(row: any): UserWithPasswordHash {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as UserRole,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    canonicalPath: row.canonical_path,
    aliases: JSON.parse(row.aliases) as ProjectAliases,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    archived: !!row.archived,
    sortOrder: row.sort_order,
    category: row.category,
  };
}

function rowToThread(row: any): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    originEngine: row.origin_engine,
    engineIds: JSON.parse(row.engine_ids),
    sourceRef: row.source_ref ?? undefined,
    sourceFilePath: row.source_file_path ?? undefined,
    messageCount: row.message_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
  };
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    projectId: row.project_id,
    sourceEngine: row.source_engine,
    role: row.role,
    content: row.content,
    thought: row.thought ?? undefined,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    timestamp: row.timestamp,
    sequence: row.sequence,
    hash: row.hash,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    model: row.model ?? undefined,
    usage: row.usage ? JSON.parse(row.usage) : undefined,
    estimatedTokens: row.estimated_tokens ?? undefined,
  };
}

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceEngine: row.source_engine,
    category: row.category,
    filePath: row.file_path,
    content: row.content,
    lastModifiedAt: row.last_modified_at,
  };
}

function rowToArtifact(row: any): Artifact {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id ?? undefined,
    title: row.title,
    filePath: row.file_path,
    type: row.type,
    content: row.content,
    sourceEngine: row.source_engine,
    createdAt: row.created_at,
  };
}

export type { IngestEventStatus };
