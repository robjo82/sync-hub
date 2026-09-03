import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';

const fakeWatch = { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };

describe('expensive aggregates are memoised, but never stale', () => {
  let dir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;

  const message = (id: string, seq: number) => ({
    id, threadId: 't1', projectId: 'p1', sourceEngine: 'claude-code' as const, role: 'assistant' as const,
    content: `message ${id}`, timestamp: '2026-08-01T10:00:00.000Z', sequence: seq, hash: `h-${id}`,
    model: 'claude-opus-5',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-memo-'));
    db = new Db(join(dir, 'hub.sqlite'));
    const now = '2026-08-01T10:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'P', canonicalPath: join(dir, 'p'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
    db.upsertThread({ id: 't1', projectId: 'p1', title: 'T', originEngine: 'claude-code', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
    db.insertMessage(message('m1', 0));
    app = createApp({
      db, registry: new ProjectRegistry(db), watchHandle: fakeWatch, rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: join(dir, 'a') }, importsDir: join(dir, 'i'),
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const costs = async () => (await app.inject({ method: 'GET', url: '/api/costs' })).json();

  it('serves the same figures twice without recomputing', async () => {
    const first = await costs();
    expect(first.totalCostUsd).toBeCloseTo(5, 3); // 1M input on claude-opus-5 at $5/MTok
    expect((await costs()).totalCostUsd).toBeCloseTo(first.totalCostUsd, 6);
  });

  it('reflects a newly ingested message immediately', async () => {
    const before = (await costs()).totalCostUsd;
    db.insertMessage(message('m2', 1));
    // A memo keyed on anything but ingest activity would still be serving `before` here — which
    // would mean a dashboard quietly showing yesterday's spend.
    expect((await costs()).totalCostUsd).toBeCloseTo(before + 5, 3);
  });

  it('does not confuse one filter’s result with another’s', async () => {
    const all = await costs();
    const narrowed = (await app.inject({ method: 'GET', url: '/api/costs?engine=codex' })).json();
    expect(all.totalCostUsd).toBeGreaterThan(0);
    expect(narrowed.totalCostUsd).toBe(0);
  });
});
