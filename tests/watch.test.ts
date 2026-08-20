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
