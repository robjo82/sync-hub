import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { ingestAll } from '../src/core/adapters/cowork.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'cowork');
const PROJECT_PATH = '/Users/robin/Projets/demo';

let dir: string;
let db: Db;
let registry: ProjectRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-cowork-'));
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Cowork ingestAll', () => {
  it('resolves the project via userSelectedFolders (real host path), ignoring the VM-sandboxed cwd/slug entirely', () => {
    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: PROJECT_PATH,
      aliases: { paths: [PROJECT_PATH], claudeSlugs: [], codexCwds: [] },
      createdAt: now,
      lastActiveAt: now,
    });

    const inserted = ingestAll(db, registry, FIXTURE_ROOT);
    expect(inserted).toBe(2);

    const thread = db.getThread('cowork-thread-0001');
    expect(thread?.projectId).toBe('proj-demo'); // not the meaningless VM slug
    expect(thread?.originEngine).toBe('claude-code'); // Cowork sessions ARE Claude Code under the hood

    const messages = db.getMessagesForThread('cowork-thread-0001');
    expect(messages.map((m) => m.content)).toEqual(['Bonjour depuis Cowork', 'Bonjour, ceci est une réponse factice pour le test Cowork.']);
  });

  it('lands sessions with no userSelectedFolders in "unassigned" rather than guessing from the sandboxed cwd', () => {
    // No proj-demo registered this time — userSelectedFolders points nowhere resolvable.
    ingestAll(db, registry, FIXTURE_ROOT);
    expect(db.getThread('cowork-thread-0001')?.projectId).toBe(UNASSIGNED_PROJECT_ID);
  });

  it('is idempotent across repeated scans', () => {
    ingestAll(db, registry, FIXTURE_ROOT);
    const second = ingestAll(db, registry, FIXTURE_ROOT);
    expect(second).toBe(0);
  });
});
