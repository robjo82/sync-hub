import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry, pathToClaudeSlug } from '../src/core/registry.js';
import { ingestClaudeCodeMemories, ingestCodexMemories } from '../src/core/adapters/memories.js';

const CLAUDE_FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'memories', 'claude-code');
const CODEX_FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'memories', 'codex', 'rollout_summaries');
const PROJECT_PATH = '/Users/robin/Projets/demo';

let dir: string;
let db: Db;
let registry: ProjectRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-memories-'));
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);
  const now = new Date().toISOString();
  db.upsertProject({
    id: 'proj-demo',
    name: 'demo',
    canonicalPath: PROJECT_PATH,
    aliases: { paths: [PROJECT_PATH], claudeSlugs: [pathToClaudeSlug(PROJECT_PATH)], codexCwds: [PROJECT_PATH] },
    createdAt: now,
    lastActiveAt: now,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestClaudeCodeMemories', () => {
  it('skips MEMORY.md (the index) and ingests real memory files with their real category from frontmatter', () => {
    const count = ingestClaudeCodeMemories(db, registry, CLAUDE_FIXTURE_ROOT);
    expect(count).toBe(1); // only feedback_style.md — MEMORY.md is excluded

    const memories = db.getMemoriesForProject('proj-demo');
    expect(memories).toHaveLength(1);
    expect(memories[0].category).toBe('feedback');
    expect(memories[0].content).toContain('guillemets français');
    // The frontmatter block itself must not leak into the stored content.
    expect(memories[0].content).not.toContain('node_type: memory');
  });

  it('is idempotent by file path (re-running does not duplicate rows)', () => {
    ingestClaudeCodeMemories(db, registry, CLAUDE_FIXTURE_ROOT);
    ingestClaudeCodeMemories(db, registry, CLAUDE_FIXTURE_ROOT);
    expect(db.getMemoriesForProject('proj-demo')).toHaveLength(1);
  });
});

describe('ingestCodexMemories', () => {
  it('parses the real (non-delimited) leading key:value header and resolves the project via the explicit cwd field', () => {
    const count = ingestCodexMemories(db, registry, CODEX_FIXTURE_ROOT);
    expect(count).toBe(1);

    const memories = db.getMemoriesForProject('proj-demo');
    expect(memories).toHaveLength(1);
    expect(memories[0].sourceEngine).toBe('codex');
    expect(memories[0].category).toBe('project');
    expect(memories[0].content).toContain('Résumé factice de tâche');
    // The leading key:value header must not leak into the stored content.
    expect(memories[0].content).not.toContain('thread_id:');
  });
});
