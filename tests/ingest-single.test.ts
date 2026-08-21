import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { tryIngestMissingThread } from '../src/core/ingest-single.js';

let dir: string;
let db: Db;
let registry: ProjectRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-ingest-single-'));
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tryIngestMissingThread', () => {
  it('returns true immediately, with no filesystem lookup, when the thread is already known', () => {
    db.upsertThread({
      id: 'already-here',
      projectId: 'unassigned',
      title: 'x',
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    // Roots deliberately point nowhere real — a lookup would throw/return nothing, proving the
    // early return short-circuits before any adapter is touched.
    expect(tryIngestMissingThread(db, registry, 'already-here', { claudeCodeRoot: join(dir, 'nope') })).toBe(true);
  });

  it('finds and ingests a brand-new Claude Code session file by its session id', () => {
    const claudeRoot = join(dir, 'claude-root');
    const slugDir = join(claudeRoot, '-Users-robin-Projets-demo');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      join(slugDir, 'race-session-0001.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Bonjour' } }) + '\n',
    );

    expect(db.getThread('race-session-0001')).toBeUndefined();
    const found = tryIngestMissingThread(db, registry, 'race-session-0001', { claudeCodeRoot: claudeRoot });
    expect(found).toBe(true);
    expect(db.getThread('race-session-0001')).toBeDefined();
  });

  it('finds and ingests a brand-new Codex session by the uuid embedded in its filename, without reading unrelated files', () => {
    const codexRoot = join(dir, 'codex-root');
    mkdirSync(codexRoot, { recursive: true });
    const sessionId = '01a09999-7000-8000-9000-000000000001';
    writeFileSync(
      join(codexRoot, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'session_meta', timestamp: 't0', payload: { id: sessionId, cwd: '/tmp/nowhere', timestamp: 't0' } }),
        JSON.stringify({
          type: 'response_item',
          timestamp: 't1',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour' }] },
        }),
      ].join('\n') + '\n',
    );
    // A decoy file whose content would need to be read to find its id — proves matching happens
    // via the filename, not by opening every candidate file.
    writeFileSync(join(codexRoot, 'rollout-2026-01-01T00-00-00-not-a-real-uuid.jsonl'), 'not valid jsonl at all {{{');

    const found = tryIngestMissingThread(db, registry, sessionId, { codexRoots: [codexRoot] });
    expect(found).toBe(true);
    expect(db.getThread(sessionId)).toBeDefined();
  });

  it('finds and ingests a brand-new Antigravity session by its directory name', () => {
    const antigravityRoot = join(dir, 'antigravity-root');
    const sessionDir = join(antigravityRoot, 'race-antigravity-0001', '.system_generated', 'logs');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'transcript_full.jsonl'),
      JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nBonjour\n</USER_REQUEST>' }) +
        '\n',
    );

    const found = tryIngestMissingThread(db, registry, 'race-antigravity-0001', { antigravityRoot });
    expect(found).toBe(true);
    expect(db.getThread('race-antigravity-0001')).toBeDefined();
  });

  it('returns false when the id matches no session file in any engine, rather than throwing', () => {
    const found = tryIngestMissingThread(db, registry, 'never-existed-anywhere', {
      claudeCodeRoot: join(dir, 'empty-claude'),
      codexRoots: [join(dir, 'empty-codex')],
      antigravityRoot: join(dir, 'empty-antigravity'),
    });
    expect(found).toBe(false);
    expect(db.getThread('never-existed-anywhere')).toBeUndefined();
  });
});
