import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { updateAllPointerFiles } from '../src/core/pointer-files.js';

describe('updateAllPointerFiles — scoped refresh', () => {
  let dir: string;
  let db: Db;
  let quiet: string;
  let busy: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-ptr-'));
    db = new Db(join(dir, 'hub.sqlite'));
    quiet = join(dir, 'quiet');
    busy = join(dir, 'busy');
    mkdirSync(quiet, { recursive: true });
    mkdirSync(busy, { recursive: true });

    db.upsertProject({
      id: 'quiet', name: 'Quiet', canonicalPath: quiet, aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
    db.upsertProject({
      id: 'busy', name: 'Busy', canonicalPath: busy, aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-09-03T12:00:00.000Z',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an untouched project’s files alone', () => {
    updateAllPointerFiles(db);
    const before = statSync(join(quiet, 'CLAUDE.md')).mtimeMs;
    const marker = readFileSync(join(quiet, 'CLAUDE.md'), 'utf-8');

    // A pass scoped to "since 2026-06-01" must skip the project last active in January. Rewriting
    // it would only churn the file's mtime — which is what made this run 134 writes per event.
    updateAllPointerFiles(db, new Date(), new Date('2026-06-01T00:00:00.000Z'));

    expect(statSync(join(quiet, 'CLAUDE.md')).mtimeMs).toBe(before);
    expect(readFileSync(join(quiet, 'CLAUDE.md'), 'utf-8')).toBe(marker);
  });

  it('still refreshes a project that saw activity', () => {
    writeFileSync(join(busy, 'CLAUDE.md'), 'contenu préexistant\n');
    updateAllPointerFiles(db, new Date(), new Date('2026-06-01T00:00:00.000Z'));

    const written = readFileSync(join(busy, 'CLAUDE.md'), 'utf-8');
    expect(written).toContain('contenu préexistant');
    expect(written).toContain('Sync-hub');
  });

  it('refreshes everything when no cutoff is given', () => {
    updateAllPointerFiles(db);
    expect(readFileSync(join(quiet, 'CLAUDE.md'), 'utf-8')).toContain('Sync-hub');
    expect(readFileSync(join(busy, 'CLAUDE.md'), 'utf-8')).toContain('Sync-hub');
  });
});
