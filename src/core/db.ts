import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Artifact,
  EngineType,
  IngestEventStatus,
  IngestLogEntry,
  McpCallLogEntry,
  Memory,
  Message,
  Project,
  ProjectAliases,
  Thread,
} from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '{"paths":[],"claudeSlugs":[],"codexCwds":[]}',
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER
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
  { table: 'threads', column: 'source_ref', definition: 'TEXT' },
  { table: 'threads', column: 'source_file_path', definition: 'TEXT' },
];

const DEFAULT_CATEGORIES = ['ekonum', 'client', 'perso'];

export class Db {
  readonly raw: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.raw = new Database(filePath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
    for (const { table, column, definition } of EXPECTED_COLUMNS) {
      ensureColumn(this.raw, table, column, definition);
    }
    // The minimum set asked for — seeded once so they always show up in the picker, even before
    // any project has been sorted into one yet. createCategory is idempotent (INSERT OR IGNORE).
    for (const name of DEFAULT_CATEGORIES) this.createCategory(name);
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
  }

  setThreadStatus(id: string, status: 'active' | 'archived'): void {
    this.raw.prepare('UPDATE threads SET status = ? WHERE id = ?').run(status, id);
  }

  /** Removes the thread and (via ON DELETE CASCADE) its messages from sync-hub's own store — never
   * the real source file, which archive.deleteThread moves aside first, the same safe way
   * archiveThread does. Purely a sync-hub-side purge, e.g. for accidental duplicate imports. */
  deleteThread(id: string): void {
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
      this.raw
        .prepare(
          `INSERT INTO messages
             (id, thread_id, project_id, source_engine, role, content, thought, tool_calls, tool_results, attachments, timestamp, sequence, hash, metadata)
           VALUES
             (@id, @threadId, @projectId, @sourceEngine, @role, @content, @thought, @toolCalls, @toolResults, @attachments, @timestamp, @sequence, @hash, @metadata)`,
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
        });
      return true;
    } catch (err: any) {
      if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed: messages.hash')) {
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
                   attachments = @attachments, timestamp = @timestamp, sequence = @sequence, hash = @hash, metadata = @metadata
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
          });
        return true;
      }
      throw err;
    }
  }

  getMessagesForThread(threadId: string): Message[] {
    const rows = this.raw
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence ASC')
      .all(threadId) as any[];
    return rows.map(rowToMessage);
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

  searchTranscripts(query: string, limit = 50): Message[] {
    const rows = this.raw
      .prepare('SELECT * FROM messages WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?')
      .all(`%${query}%`, limit) as any[];
    return rows.map(rowToMessage);
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
