import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import type { WatchHandle } from '../src/core/watch.js';
import type { Message, Project } from '../src/types.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

let dir: string;
let projectPath: string;
let db: Db;
let registry: ProjectRegistry;
let app: FastifyInstance;
let rescan: ReturnType<typeof vi.fn>;

function fakeWatchHandle(): WatchHandle {
  return { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-demo',
    name: 'demo',
    canonicalPath: projectPath,
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: 'm1',
    threadId: 't1',
    projectId: 'proj-demo',
    sourceEngine: 'claude-code',
    role: 'user',
    content: 'Bonjour',
    timestamp: now,
    sequence: 0,
    hash: 'h1',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-server-'));
  projectPath = join(dir, 'demo-project');
  mkdirSync(projectPath, { recursive: true });
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);
  db.upsertProject(project());
  db.upsertThread({
    id: 't1',
    projectId: 'proj-demo',
    title: 'Fil de test',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });
  rescan = vi.fn();
  app = createApp({
    db,
    registry,
    watchHandle: fakeWatchHandle(),
    rescan,
    archiveRoots: { syncHubArchiveRoot: join(dir, 'sync-hub-archive'), codexArchiveRoot: join(dir, 'codex-archived-sessions') },
    trashRoot: join(dir, 'trash'),
    importsDir: join(dir, 'imports'),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sync-hub HTTP API', () => {
  it('GET /api/health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/stats returns real, computed values — never the ai-sync-hub-style hardcoded stats', async () => {
    db.insertMessage(message());
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    const stats = res.json();
    expect(stats.totalMessages).toBe(1);
    expect(stats.totalProjects).toBe(1); // excludes the unassigned sentinel
    const claudeHealth = stats.engines.find((e: any) => e.engine === 'claude-code');
    expect(claudeHealth.messageCount).toBe(1);
    expect(typeof claudeHealth.storageRootExists).toBe('boolean'); // real filesystem probe, not a fixed `true`
  });

  it('GET /api/search finds a substring across messages and reports which project/thread it came from', async () => {
    db.insertMessage(message({ content: 'problème de balance comptable chez un client' }));
    const res = await app.inject({ method: 'GET', url: '/api/search?q=balance%20comptable' });
    expect(res.statusCode).toBe(200);
    const results = res.json();
    expect(results).toHaveLength(1);
    expect(results[0].message.content).toContain('balance comptable');
    expect(results[0].projectName).toBe('demo');
    expect(results[0].threadTitle).toBe('Fil de test');
  });

  it('GET /api/search with an empty query returns no results rather than everything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=' });
    expect(res.json()).toEqual([]);
  });

  it('GET /api/coverage reports per-project, per-engine last activity, excluding the unassigned bucket', async () => {
    db.insertMessage(message({ sourceEngine: 'claude-code', timestamp: '2026-01-01T00:00:00Z' }));
    db.insertMessage(message({ id: 'm2', hash: 'h2', sequence: 1, sourceEngine: 'codex', timestamp: '2026-01-02T00:00:00Z' }));

    const res = await app.inject({ method: 'GET', url: '/api/coverage' });
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe('proj-demo');
    expect(rows[0].engines['claude-code']).toBe('2026-01-01T00:00:00Z');
    expect(rows[0].engines.codex).toBe('2026-01-02T00:00:00Z');
  });

  it('GET /api/costs estimates spend from real per-message model + usage, scoped by projectId when given', async () => {
    db.insertMessage(message({ model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
    const res = await app.inject({ method: 'GET', url: '/api/costs?projectId=proj-demo' });
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    expect(summary.totalCostUsd).toBeCloseTo(2, 10); // $2/MTok input for claude-sonnet-5
    expect(summary.totalCostEur).toBeCloseTo(2 * 0.92, 10);
    expect(summary.byModel[0]).toMatchObject({ model: 'claude-sonnet-5', costUsd: 2, inputTokens: 1_000_000, outputTokens: 0, messageCount: 1 });
  });

  it('GET /api/projects/:id/threads and /api/threads/:id/messages', async () => {
    db.insertMessage(message());
    const threadsRes = await app.inject({ method: 'GET', url: '/api/projects/proj-demo/threads' });
    expect(threadsRes.json()).toHaveLength(1);

    const messagesRes = await app.inject({ method: 'GET', url: '/api/threads/t1/messages' });
    expect(messagesRes.json()).toHaveLength(1);
    expect(messagesRes.json()[0].content).toBe('Bonjour');
  });

  it('returns 404 for an unknown project or thread', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/threads/nope/messages' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/threads/nope' })).statusCode).toBe(404);
  });

  it('GET /api/threads/:id returns the thread itself (not just its messages)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/threads/t1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 't1', projectId: 'proj-demo', title: 'Fil de test' });
  });

  it('POST /api/threads/:id/delete removes the thread from sync-hub entirely, not just archives it', async () => {
    db.insertMessage(message());
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/delete' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/threads/t1' })).statusCode).toBe(404);
  });

  it('POST /api/projects/:id/assign teaches the registry a new alias — a previously-unassigned cwd now resolves to the real project', async () => {
    const adhocCwd = '/Users/robin/Documents/Codex/2026-08-14/some-adhoc-slug';
    expect(registry.resolveByCodexCwd(adhocCwd)).toBe(UNASSIGNED_PROJECT_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-demo/assign',
      payload: { kind: 'codexCwds', value: adhocCwd },
    });
    expect(res.statusCode).toBe(200);
    expect(registry.resolveByCodexCwd(adhocCwd)).toBe('proj-demo');
  });

  it('POST /api/threads/:id/assign re-parents an unassigned thread to a real project AND teaches the registry its cwd', async () => {
    const adhocCwd = '/Users/robin/Documents/Codex/2026-08-14/reprise-orpheline';
    db.upsertThread({
      id: 'orphan-thread',
      projectId: UNASSIGNED_PROJECT_ID,
      title: 'Session orpheline',
      originEngine: 'codex',
      engineIds: { codex: 'orphan-thread' },
      sourceRef: adhocCwd,
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    db.insertMessage(message({ id: 'om1', hash: 'oh1', threadId: 'orphan-thread', projectId: UNASSIGNED_PROJECT_ID, sourceEngine: 'codex' }));

    const res = await app.inject({ method: 'POST', url: '/api/threads/orphan-thread/assign', payload: { projectId: 'proj-demo' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().projectId).toBe('proj-demo');

    // The thread's messages moved too, not just the thread row itself.
    expect(db.getMessagesForThread('orphan-thread')[0].projectId).toBe('proj-demo');
    // And the registry now resolves this cwd directly, so the NEXT Codex session there lands correctly too.
    expect(registry.resolveByCodexCwd(adhocCwd)).toBe('proj-demo');
  });

  it('POST /api/threads/:id/archive moves the real source file and hides the thread from the default list', async () => {
    const sourcePath = join(dir, 'session.jsonl');
    writeFileSync(sourcePath, '{}\n');
    db.upsertThread({
      id: 't-archive',
      projectId: 'proj-demo',
      title: 'À archiver',
      originEngine: 'claude-code',
      engineIds: {},
      sourceFilePath: sourcePath,
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });

    const res = await app.inject({ method: 'POST', url: '/api/threads/t-archive/archive' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thread.status).toBe('archived');
    expect(body.movedFileTo).toContain('sync-hub-archive');
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(body.movedFileTo)).toBe(true);

    const listRes = await app.inject({ method: 'GET', url: '/api/projects/proj-demo/threads' });
    expect(listRes.json().find((t: any) => t.id === 't-archive')).toBeUndefined();

    const withArchivedRes = await app.inject({ method: 'GET', url: '/api/projects/proj-demo/threads?includeArchived=true' });
    expect(withArchivedRes.json().find((t: any) => t.id === 't-archive')).toBeDefined();
  });

  it('POST /api/projects/:id/archive hides the project and cascades to archive its active threads', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/archive' });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.archived).toBe(true);
    expect(res.json().threads).toHaveLength(1); // the one thread seeded in beforeEach

    const listRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(listRes.json().find((p: any) => p.id === 'proj-demo')).toBeUndefined();

    const withArchivedRes = await app.inject({ method: 'GET', url: '/api/projects?includeArchived=true' });
    expect(withArchivedRes.json().find((p: any) => p.id === 'proj-demo')).toBeDefined();
  });

  it('POST /api/projects/:id/unarchive brings the project back into the default list', async () => {
    await app.inject({ method: 'POST', url: '/api/projects/proj-demo/archive' });
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/unarchive' });
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBe(false);
  });

  it('POST /api/projects/:id/rename updates the display name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/rename', payload: { name: 'C00125 - Acritec' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('C00125 - Acritec');
    expect(db.getProject('proj-demo')?.name).toBe('C00125 - Acritec');
  });

  it('POST /api/projects/:id/rename rejects an empty name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/rename', payload: { name: '  ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('name_required');
  });

  it('POST /api/projects/:id/delete requires confirm:true — refuses an unconfirmed request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/delete', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('confirmation_required');
    // Nothing was touched.
    expect(db.getProject('proj-demo')).toBeDefined();
    expect(existsSync(projectPath)).toBe(true);
  });

  it('POST /api/projects/:id/delete with confirm:true moves the real folder to Trash and removes the project', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/delete', payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(res.json().movedFolderTo)).toBe(true);
    expect(db.getProject('proj-demo')).toBeUndefined();
  });

  it('POST /api/projects/:id/merge folds the source project into the target — threads move, source disappears', async () => {
    const otherPath = join(dir, 'other-project');
    mkdirSync(otherPath, { recursive: true });
    db.upsertProject(project({ id: 'proj-other', name: 'Autre nom du même client', canonicalPath: otherPath }));
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/merge', payload: { sourceId: 'proj-other' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('proj-demo');
    expect(db.getProject('proj-other')).toBeUndefined();
    // Real files are never touched by a merge — only sync-hub's own records.
    expect(existsSync(otherPath)).toBe(true);
  });

  it('POST /api/projects/:id/merge without sourceId is rejected', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/merge', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('source_id_required');
  });

  it('POST /api/projects/:id/merge refuses an unknown source or target project', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/proj-demo/merge', payload: { sourceId: 'does-not-exist' } });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/projects/reorder persists a manual order, overriding last-activity order', async () => {
    db.upsertProject(project({ id: 'proj-other', name: 'other', canonicalPath: join(dir, 'other-project'), lastActiveAt: new Date(Date.now() + 1000).toISOString() }));
    const res = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: { orderedIds: ['proj-demo', 'proj-other'] } });
    expect(res.statusCode).toBe(200);

    const listRes = await app.inject({ method: 'GET', url: '/api/projects' });
    // The always-present "unassigned" sentinel was never manually ordered, so it trails behind.
    expect(listRes.json().map((p: any) => p.id)).toEqual(['proj-demo', 'proj-other', 'unassigned']);
  });

  it('POST /api/projects/reorder without orderedIds is rejected', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/reorder', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ordered_ids_required');
  });

  it('POST /api/sync/rescan triggers the injected rescan function', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/rescan' });
    expect(res.statusCode).toBe(200);
    expect(rescan).toHaveBeenCalledOnce();
  });

  describe('POST /api/imports/:tool — uploading an export .zip from the dashboard', () => {
    function multipartBody(filename: string, content: Buffer): { payload: Buffer; contentType: string } {
      const boundary = '----sync-hub-test-boundary';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
    }

    function realZipFixture(): Buffer {
      const stageDir = mkdtempSync(join(tmpdir(), 'sync-hub-zip-fixture-'));
      writeFileSync(join(stageDir, 'conversations.json'), '[]');
      execSync(`zip -q -j fixture.zip conversations.json`, { cwd: stageDir });
      const zipBytes = readFileSync(join(stageDir, 'fixture.zip'));
      rmSync(stageDir, { recursive: true, force: true });
      return zipBytes;
    }

    it('rejects an unknown tool', async () => {
      const { payload, contentType } = multipartBody('export.zip', Buffer.from('x'));
      const res = await app.inject({ method: 'POST', url: '/api/imports/notatool', headers: { 'content-type': contentType }, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('unknown_tool');
    });

    it('rejects a non-.zip filename', async () => {
      const { payload, contentType } = multipartBody('export.json', Buffer.from('x'));
      const res = await app.inject({ method: 'POST', url: '/api/imports/claude', headers: { 'content-type': contentType }, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('zip_required');
    });

    it('extracts a real .zip into imports/<tool>/ and triggers a rescan', async () => {
      const { payload, contentType } = multipartBody('export.zip', realZipFixture());
      const res = await app.inject({ method: 'POST', url: '/api/imports/claude', headers: { 'content-type': contentType }, payload });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(existsSync(join(dir, 'imports', 'claude', 'conversations.json'))).toBe(true);
      expect(rescan).toHaveBeenCalledOnce();
    });
  });
});
