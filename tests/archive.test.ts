import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { archiveThread, deleteProject, deleteThread } from '../src/core/archive.js';
import type { Project, Thread } from '../src/types.js';

let dir: string;
let db: Db;
let syncHubArchiveRoot: string;
let codexArchiveRoot: string;

function thread(overrides: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    id: 't1',
    projectId: 'proj-demo',
    title: 'Fil de test',
    originEngine: 'codex',
    engineIds: {},
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-archive-'));
  db = new Db(join(dir, 'hub.sqlite'));
  const now = new Date().toISOString();
  db.upsertProject({
    id: 'proj-demo',
    name: 'demo',
    canonicalPath: join(dir, 'demo-project'),
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: now,
    lastActiveAt: now,
  });
  syncHubArchiveRoot = join(dir, 'sync-hub-archive');
  codexArchiveRoot = join(dir, 'codex-archived-sessions');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('archiveThread', () => {
  it('moves a Codex source file into the (native-equivalent) codex archive root, preserving content', () => {
    const sessionsDir = join(dir, 'codex-sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sourcePath = join(sessionsDir, 'rollout-fixture.jsonl');
    writeFileSync(sourcePath, '{"real":"content"}\n');

    db.upsertThread(thread({ originEngine: 'codex', sourceFilePath: sourcePath }));

    const result = archiveThread(db, db.getThread('t1')!, { syncHubArchiveRoot, codexArchiveRoot });

    expect(result.ok).toBe(true);
    expect(result.movedFileTo).toBe(join(codexArchiveRoot, 'rollout-fixture.jsonl'));
    expect(existsSync(sourcePath)).toBe(false); // gone from the original (active) location
    expect(existsSync(result.movedFileTo!)).toBe(true); // NOT deleted — moved, still readable
    expect(readFileSync(result.movedFileTo!, 'utf-8')).toBe('{"real":"content"}\n');

    const updated = db.getThread('t1')!;
    expect(updated.status).toBe('archived');
    expect(updated.sourceFilePath).toBe(result.movedFileTo);
  });

  it('moves a Claude Code source file into the sync-hub-managed archive (no native equivalent exists)', () => {
    const projectsDir = join(dir, 'claude-projects', '-Users-robin-Projets-demo');
    mkdirSync(projectsDir, { recursive: true });
    const sourcePath = join(projectsDir, 'session.jsonl');
    writeFileSync(sourcePath, '{"real":"claude content"}\n');

    db.upsertThread(thread({ id: 't2', originEngine: 'claude-code', sourceFilePath: sourcePath }));

    const result = archiveThread(db, db.getThread('t2')!, { syncHubArchiveRoot, codexArchiveRoot });

    expect(result.movedFileTo).toBe(join(syncHubArchiveRoot, 'claude-code', 'session.jsonl'));
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(result.movedFileTo!)).toBe(true);
    expect(readFileSync(result.movedFileTo!, 'utf-8')).toBe('{"real":"claude content"}\n');
  });

  it('never deletes anything — archiving a thread with no source file just flips status, sync-hub-side only', () => {
    db.upsertThread(thread({ id: 't3', originEngine: 'codex', sourceFilePath: undefined }));
    const result = archiveThread(db, db.getThread('t3')!, { syncHubArchiveRoot, codexArchiveRoot });
    expect(result.movedFileTo).toBeUndefined();
    expect(db.getThread('t3')!.status).toBe('archived');
  });

  it('is idempotent — archiving an already-archived thread is a no-op that reports so', () => {
    db.upsertThread(thread({ id: 't4', status: 'archived' }));
    const result = archiveThread(db, db.getThread('t4')!, { syncHubArchiveRoot, codexArchiveRoot });
    expect(result.note).toContain('Déjà archivé');
  });

  it('a full rescan after archiving a Codex thread must not silently un-archive it', () => {
    // Regression guard for the exact bug this session almost shipped: upsertThread used to
    // always overwrite `status`, so re-discovering the (now-moved, but still scanned) file
    // in ~/.codex/archived_sessions/ on the next scan would flip it straight back to active.
    const sessionsDir = join(dir, 'codex-sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sourcePath = join(sessionsDir, 'rollout-fixture.jsonl');
    writeFileSync(sourcePath, '{}\n');
    db.upsertThread(thread({ id: 't5', originEngine: 'codex', sourceFilePath: sourcePath }));

    const result = archiveThread(db, db.getThread('t5')!, { syncHubArchiveRoot, codexArchiveRoot });

    // Simulate the adapter re-discovering the same session at its new (archived) path on a later scan.
    db.upsertThread({ ...db.getThread('t5')!, sourceFilePath: result.movedFileTo!, status: 'active' });

    expect(db.getThread('t5')!.status).toBe('archived');
  });
});

describe('deleteThread', () => {
  it('moves the real source file aside (same as archiveThread) and removes the thread + its messages from sync-hub, never touching the file itself', () => {
    const sessionsDir = join(dir, 'codex-sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sourcePath = join(sessionsDir, 'rollout-fixture.jsonl');
    writeFileSync(sourcePath, '{"real":"content"}\n');
    db.upsertThread(thread({ id: 't-del', originEngine: 'codex', sourceFilePath: sourcePath }));
    db.insertMessage({
      id: 'm-del',
      threadId: 't-del',
      projectId: 'proj-demo',
      sourceEngine: 'codex',
      role: 'user',
      content: 'x',
      timestamp: new Date().toISOString(),
      sequence: 0,
      hash: 'h-del',
    });

    const result = deleteThread(db, db.getThread('t-del')!, { syncHubArchiveRoot, codexArchiveRoot });

    expect(result.ok).toBe(true);
    expect(result.movedFileTo).toBe(join(codexArchiveRoot, 'rollout-fixture.jsonl'));
    expect(existsSync(sourcePath)).toBe(false); // gone from the active location
    expect(existsSync(result.movedFileTo!)).toBe(true); // moved, never deleted
    expect(readFileSync(result.movedFileTo!, 'utf-8')).toBe('{"real":"content"}\n');

    expect(db.getThread('t-del')).toBeUndefined();
    expect(db.getMessagesForThread('t-del')).toHaveLength(0); // cascaded
  });

  it('deletes cleanly even with no real source file to move', () => {
    db.upsertThread(thread({ id: 't-del-nofile', sourceFilePath: undefined }));
    const result = deleteThread(db, db.getThread('t-del-nofile')!, { syncHubArchiveRoot, codexArchiveRoot });
    expect(result.ok).toBe(true);
    expect(db.getThread('t-del-nofile')).toBeUndefined();
  });

  it('deletes an already-archived thread without trying to move its file again', () => {
    db.upsertThread(thread({ id: 't-del-archived', status: 'archived' }));
    const result = deleteThread(db, db.getThread('t-del-archived')!, { syncHubArchiveRoot, codexArchiveRoot });
    expect(result.note).toContain('Déjà archivé');
    expect(db.getThread('t-del-archived')).toBeUndefined();
  });
});

describe('deleteProject', () => {
  it('moves the real project folder to Trash (never rm -rf) and removes the project from the store, cascading its threads/messages', () => {
    const trashRoot = join(dir, 'trash');
    const projectFolder = join(dir, 'a-real-project');
    mkdirSync(projectFolder, { recursive: true });
    writeFileSync(join(projectFolder, 'real-file.txt'), 'contenu réel, jamais supprimé');

    const project: Project = {
      id: 'proj-to-delete',
      name: 'a-real-project',
      canonicalPath: projectFolder,
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    db.upsertProject(project);
    db.upsertThread(thread({ id: 't-in-deleted-project', projectId: 'proj-to-delete' }));
    db.insertMessage({
      id: 'm1',
      threadId: 't-in-deleted-project',
      projectId: 'proj-to-delete',
      sourceEngine: 'codex',
      role: 'user',
      content: 'x',
      timestamp: new Date().toISOString(),
      sequence: 0,
      hash: 'h1',
    });

    const result = deleteProject(db, project, { trashRoot });

    expect(result.ok).toBe(true);
    expect(existsSync(projectFolder)).toBe(false); // gone from its original location
    const trashedPath = join(trashRoot, 'a-real-project');
    expect(existsSync(trashedPath)).toBe(true); // moved, not deleted
    expect(readFileSync(join(trashedPath, 'real-file.txt'), 'utf-8')).toBe('contenu réel, jamais supprimé');

    expect(db.getProject('proj-to-delete')).toBeUndefined();
    expect(db.getThread('t-in-deleted-project')).toBeUndefined(); // cascaded
    expect(db.getMessagesForThread('t-in-deleted-project')).toHaveLength(0); // cascaded
  });

  it('handles a name collision in Trash without overwriting whatever is already there', () => {
    const trashRoot = join(dir, 'trash');
    mkdirSync(join(trashRoot, 'dup-name'), { recursive: true });
    writeFileSync(join(trashRoot, 'dup-name', 'already-in-trash.txt'), 'ne doit pas être écrasé');

    const projectFolder = join(dir, 'dup-name');
    mkdirSync(projectFolder, { recursive: true });
    const project: Project = {
      id: 'proj-dup',
      name: 'dup-name',
      canonicalPath: projectFolder,
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    db.upsertProject(project);

    const result = deleteProject(db, project, { trashRoot });

    expect(result.ok).toBe(true);
    expect(existsSync(join(trashRoot, 'dup-name', 'already-in-trash.txt'))).toBe(true); // untouched
    expect(existsSync(result.movedFolderTo!)).toBe(true);
    expect(result.movedFolderTo).not.toBe(join(trashRoot, 'dup-name'));
  });

  it('removes the project from the store even when it has no real folder (e.g. already gone)', () => {
    const project: Project = {
      id: 'proj-no-folder',
      name: 'ghost',
      canonicalPath: join(dir, 'never-existed'),
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    db.upsertProject(project);

    const result = deleteProject(db, project, { trashRoot: join(dir, 'trash') });

    expect(result.ok).toBe(true);
    expect(db.getProject('proj-no-folder')).toBeUndefined();
  });
});
