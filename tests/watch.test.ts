import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry, pathToClaudeSlug } from '../src/core/registry.js';
import { startWatching } from '../src/core/watch.js';

function line(role: 'user' | 'assistant', text: string, uuid: string, ts: string) {
  return JSON.stringify({
    type: role,
    uuid,
    timestamp: ts,
    sessionId: 'watch-session',
    cwd: '/Users/robin/Projets/demo',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
  });
}

describe('startWatching — live tail across both engines', () => {
  let dir: string;
  let db: Db;
  let registry: ProjectRegistry;
  let claudeRoot: string;
  let codexRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-watch-'));
    claudeRoot = join(dir, 'claude-projects');
    codexRoot = join(dir, 'codex-sessions');
    mkdirSync(join(claudeRoot, '-Users-robin-Projets-demo'), { recursive: true });
    mkdirSync(codexRoot, { recursive: true });

    db = new Db(join(dir, 'hub.sqlite'));
    registry = new ProjectRegistry(db);
    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: '/Users/robin/Projets/demo',
      aliases: {
        paths: ['/Users/robin/Projets/demo'],
        claudeSlugs: [pathToClaudeSlug('/Users/robin/Projets/demo')],
        codexCwds: ['/Users/robin/Projets/demo'],
      },
      createdAt: now,
      lastActiveAt: now,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The native fsevents backend that production uses cannot be covered here: under vitest it
  // simply does not deliver events (tried, and it times out — which is exactly why the watcher
  // forces polling for tests). It was instead verified out of band against the real production
  // config: creating a .jsonl, appending to it, and confirming a sibling .png raised nothing.
  it('never wakes for a file that is not a transcript', async () => {
    // Antigravity's brain/ holds ~3 700 non-transcript files against 459 real ones. They were
    // watched and then discarded inside ingest; now they are refused before that, which is where
    // most of the watcher's work went.
    const events: { filePath: string }[] = [];
    const handle = startWatching(db, registry, {
      onIngest: (e) => events.push(e),
      claudeCodeRoot: claudeRoot,
      codexRoots: [codexRoot],
      usePolling: false,
    });
    await handle.ready();

    const dirPath = join(claudeRoot, '-Users-robin-Projets-demo');
    writeFileSync(join(dirPath, 'scratch.png'), 'pas un transcript');
    writeFileSync(join(dirPath, 'notes.md'), '# rien à ingérer');
    // A real transcript alongside them still lands, so this proves the filter is selective and
    // not simply broken.
    writeFileSync(join(dirPath, 'mixed.jsonl'), line('user', 'Moi si', 'm1', '2026-01-01T00:00:00Z') + '\n');

    await waitFor(() => db.getMessagesForThread('mixed').length === 1);
    expect(events.every((e) => e.filePath.endsWith('.jsonl'))).toBe(true);
    await handle.close();
  }, 20000);

  it('ingests a newly-added Claude Code session file, then appended lines, without duplicating', async () => {
    const events: { engine: string; inserted: number }[] = [];
    const handle = startWatching(db, registry, {
      onIngest: (e) => events.push(e),
      claudeCodeRoot: claudeRoot,
      codexRoots: [codexRoot],
    });

    await handle.ready(); // otherwise a file written before the initial scan completes is treated as pre-existing and never emits 'add'

    const filePath = join(claudeRoot, '-Users-robin-Projets-demo', 'watch-session.jsonl');
    writeFileSync(filePath, line('user', 'Bonjour', 'u1', '2026-01-01T00:00:00Z') + '\n');

    await waitFor(() => db.getMessagesForThread('watch-session').length === 1);

    appendFileSync(filePath, line('assistant', 'Salut !', 'a1', '2026-01-01T00:00:01Z') + '\n');

    await waitFor(() => db.getMessagesForThread('watch-session').length === 2);

    const messages = db.getMessagesForThread('watch-session');
    expect(messages.map((m) => m.content)).toEqual(['Bonjour', 'Salut !']);
    expect(events.length).toBeGreaterThanOrEqual(2);

    await handle.close();
  }, 20000);
});

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
