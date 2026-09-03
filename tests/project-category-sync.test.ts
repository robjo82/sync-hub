import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';

describe('project category survives sync and rescans', () => {
  let dir: string;
  let db: Db;
  const now = '2026-09-03T10:00:00.000Z';
  const base = {
    id: 'p1',
    name: 'Acritec',
    canonicalPath: '/tmp/acritec',
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: now,
    lastActiveAt: now,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-cat-'));
    db = new Db(join(dir, 'hub.sqlite'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the category when a project is written', () => {
    db.upsertProject({ ...base, category: 'client' });
    expect(db.getProjects().find((p) => p.id === 'p1')?.category).toBe('client');
  });

  it('does not lose a hand-filed category on the next rescan', () => {
    // The registry re-upserts discovered projects constantly, and what it discovers on disk has
    // no category. Overwriting flatly would erase the filing on every scan.
    db.upsertProject({ ...base, category: 'client' });
    db.upsertProject({ ...base, name: 'Acritec (renommé)' });

    const p = db.getProjects().find((x) => x.id === 'p1');
    expect(p?.category).toBe('client');
    expect(p?.name).toBe('Acritec (renommé)');
  });

  it('lets an explicit category replace an earlier one', () => {
    db.upsertProject({ ...base, category: 'client' });
    db.upsertProject({ ...base, category: 'ekonum' });
    expect(db.getProjects().find((p) => p.id === 'p1')?.category).toBe('ekonum');
  });

  it('arrives with its category through a remote batch', () => {
    // The actual reported symptom: 44 projects on the hub, every one of them uncategorised.
    const applied = db.applyRemoteBatch({
      projects: [{ ...base, category: 'client', archived: false }],
      threads: [],
      messages: [],
    });
    expect(applied.appliedProjects).toBe(1);
    expect(db.getProjects().find((p) => p.id === 'p1')?.category).toBe('client');
  });
});

describe('renameThread', () => {
  it('replaces the derived title and keeps search in step', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Db } = await import('../src/core/db.js');

    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-rename-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    const now = '2026-09-03T10:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'P', canonicalPath: join(dir, 'p'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
    db.upsertThread({
      id: 't1', projectId: 'p1', originEngine: 'claude-code', engineIds: {}, messageCount: 0,
      createdAt: now, updatedAt: now, status: 'active',
      // Exactly the failure mode: the thread opens on something technical and is named after it.
      title: 'Traceback (most recent call last): File "x.py", line 3',
    });

    try {
      db.renameThread('t1', 'Migration TVA Acritec');
      expect(db.getThread('t1')?.title).toBe('Migration TVA Acritec');
      // The search index keeps its own copy of the title; leaving it stale would make the thread
      // findable only by the name the user just rejected.
      const indexed = (db as any).raw
        .prepare('SELECT title FROM threads_fts WHERE thread_id = ?')
        .get('t1') as { title: string } | undefined;
      expect(indexed?.title).toBe('Migration TVA Acritec');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
