import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import { runPullCycle } from '../src/core/sync-pull-client.js';
import { runPushCycle } from '../src/core/sync-push-client.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';
import type { FastifyInstance } from 'fastify';

describe('Sync - Pull Client & Multi-Device Sync', () => {
  let hubDb: Db;
  let hubDbPath: string;
  let hubApp: FastifyInstance;
  let hubUrl: string;

  let deviceDb: Db;
  let deviceDbPath: string;

  const REMOTE_TOKEN = 'secret-test-token-12345';

  beforeEach(async () => {
    // 1. Setup Remote Hub
    hubDbPath = join(tmpdir(), `sync-hub-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    hubDb = new Db(hubDbPath);
    const hubRegistry = new ProjectRegistry(hubDb);

    hubApp = createApp({
      db: hubDb,
      registry: hubRegistry,
      watchHandle: { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} },
      rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: '/tmp/archived' },
      importsDir: '/tmp/imports',
      remoteToken: REMOTE_TOKEN,
    });

    const address = await hubApp.listen({ port: 0, host: '127.0.0.1' });
    hubUrl = address;

    // 2. Setup Local Device Db
    deviceDbPath = join(tmpdir(), `sync-hub-device-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    deviceDb = new Db(deviceDbPath);
  });

  afterEach(async () => {
    await hubApp.close();
    hubDb.close();
    deviceDb.close();
    try {
      rmSync(hubDbPath, { force: true });
      rmSync(deviceDbPath, { force: true });
    } catch {}
  });

  it('rejects unauthenticated pull requests', async () => {
    const res = await fetch(`${hubUrl}/api/sync/pull`);
    expect(res.status).toBe(401);
  });

  it('pulls remote projects, threads and messages incrementally and advances watermark', async () => {
    // Populate remote hub with data (e.g. from Device 1)
    hubDb.upsertProject({
      id: 'proj-1',
      name: 'Diagnostic Acritec',
      canonicalPath: '/tmp/acritec',
      aliases: { paths: [], claudeSlugs: ['acritec'], codexCwds: ['acritec'] },
      createdAt: '2026-01-01T10:00:00.000Z',
      lastActiveAt: '2026-01-01T12:00:00.000Z',
    });

    hubDb.upsertThread({
      id: 'thread-1',
      projectId: 'proj-1',
      title: 'Migration Odoo 19',
      originEngine: 'claude-code',
      engineIds: { 'claude-code': 'cc-1' },
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T12:00:00.000Z',
      messageCount: 2,
      status: 'active',
    });

    hubDb.insertMessage({
      id: 'msg-1',
      threadId: 'thread-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'user',
      content: 'Comment migrer la base vers Odoo 19 ?',
      timestamp: '2026-01-01T10:05:00.000Z',
      sequence: 1,
      hash: 'hash-m1',
    });

    hubDb.insertMessage({
      id: 'msg-2',
      threadId: 'thread-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'assistant',
      content: 'Voici les étapes recommandées...',
      timestamp: '2026-01-01T10:06:00.000Z',
      sequence: 2,
      hash: 'hash-m2',
    });

    expect(deviceDb.countAll('messages')).toBe(0);

    // Run Pull on Device 2
    const result = await runPullCycle(deviceDb, {
      remoteUrl: hubUrl,
      remoteToken: REMOTE_TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(result.appliedMessages).toBe(2);
    expect(result.newWatermark).toBe(2);

    // Verify Device 2 now has the project, thread, and messages
    expect(deviceDb.getProjects().filter((p) => p.id !== UNASSIGNED_PROJECT_ID).length).toBe(1);
    expect(deviceDb.countAll('threads')).toBe(1);
    expect(deviceDb.countAll('messages')).toBe(2);

    const project = deviceDb.getProject('proj-1');
    expect(project?.name).toBe('Diagnostic Acritec');

    const thread = deviceDb.getThread('thread-1');
    expect(thread?.title).toBe('Migration Odoo 19');

    const messages = deviceDb.getMessagesForThread('thread-1');
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe('Comment migrer la base vers Odoo 19 ?');

    // Watermark check
    const syncState = deviceDb.getRemoteSyncState(hubUrl);
    expect(syncState.lastPulledSeq).toBe(2);
    expect(syncState.lastPulledAt).toBeDefined();

    // Second pull should be a no-op since no new messages exist on the hub
    const secondResult = await runPullCycle(deviceDb, {
      remoteUrl: hubUrl,
      remoteToken: REMOTE_TOKEN,
    });
    expect(secondResult.appliedMessages).toBe(0);
    expect(deviceDb.countAll('messages')).toBe(2);
  });

  it('pulls across multiple small batches seamlessly', async () => {
    hubDb.upsertProject({
      id: 'proj-multi',
      name: 'Multi Batch Project',
      canonicalPath: '/tmp/multi',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: '2026-01-01T10:00:00.000Z',
      lastActiveAt: '2026-01-01T12:00:00.000Z',
    });

    hubDb.upsertThread({
      id: 'thread-multi',
      projectId: 'proj-multi',
      title: 'Thread Multi',
      originEngine: 'codex',
      engineIds: { codex: 'cx-1' },
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T12:00:00.000Z',
      messageCount: 5,
      status: 'active',
    });

    for (let i = 1; i <= 5; i++) {
      hubDb.insertMessage({
        id: `msg-${i}`,
        threadId: 'thread-multi',
        projectId: 'proj-multi',
        sourceEngine: 'codex',
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: `2026-01-01T10:0${i}:00.000Z`,
        sequence: i,
        hash: `hash-multi-${i}`,
      });
    }

    // Pull with batchSize = 2 -> takes 3 batches (2, 2, 1)
    const result = await runPullCycle(deviceDb, {
      remoteUrl: hubUrl,
      remoteToken: REMOTE_TOKEN,
      batchSize: 2,
    });

    expect(result.appliedMessages).toBe(5);
    expect(result.newWatermark).toBe(5);
    expect(deviceDb.countAll('messages')).toBe(5);
    expect(deviceDb.getRemoteSyncState(hubUrl).lastPulledSeq).toBe(5);
  });

  it('handles multi-device bidirectional sync (Device A pushes -> Device B pulls)', async () => {
    // Device A DB
    const deviceAPath = join(tmpdir(), `sync-hub-devA-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const deviceADb = new Db(deviceAPath);

    try {
      deviceADb.upsertProject({
        id: 'proj-shared',
        name: 'Shared Project',
        canonicalPath: '/tmp/shared',
        aliases: { paths: [], claudeSlugs: ['shared'], codexCwds: ['shared'] },
        createdAt: '2026-01-01T10:00:00.000Z',
        lastActiveAt: '2026-01-01T12:00:00.000Z',
      });

      deviceADb.upsertThread({
        id: 'thread-shared',
        projectId: 'proj-shared',
        title: 'Discussion Device A',
        originEngine: 'codex',
        engineIds: { codex: 'codex-1' },
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T12:00:00.000Z',
        messageCount: 1,
        status: 'active',
      });

      deviceADb.insertMessage({
        id: 'msg-devA-1',
        threadId: 'thread-shared',
        projectId: 'proj-shared',
        sourceEngine: 'codex',
        role: 'user',
        content: 'Question posée depuis le Mac principal',
        timestamp: '2026-01-01T10:00:00.000Z',
        sequence: 1,
        hash: 'hash-devA-1',
      });

      // Device A pushes to Hub
      await runPushCycle(deviceADb, {
        remoteUrl: hubUrl,
        remoteToken: REMOTE_TOKEN,
      });

      // Hub now has the message
      expect(hubDb.countAll('messages')).toBe(1);

      // Device B pulls from Hub
      await runPullCycle(deviceDb, {
        remoteUrl: hubUrl,
        remoteToken: REMOTE_TOKEN,
      });

      // Device B now has the message
      expect(deviceDb.countAll('messages')).toBe(1);
      const bMsg = deviceDb.getMessagesForThread('thread-shared');
      expect(bMsg[0].content).toBe('Question posée depuis le Mac principal');
    } finally {
      deviceADb.close();
      try {
        rmSync(deviceAPath, { force: true });
      } catch {}
    }
  });

  it('leaves watermark untouched on network or auth error', async () => {
    // Unreachable URL
    await runPullCycle(deviceDb, {
      remoteUrl: 'http://127.0.0.1:99999',
      remoteToken: REMOTE_TOKEN,
      requestTimeoutMs: 500,
    });
    expect(deviceDb.getRemoteSyncState('http://127.0.0.1:99999').lastPulledSeq).toBe(0);

    // Bad token (HTTP 401)
    await runPullCycle(deviceDb, {
      remoteUrl: hubUrl,
      remoteToken: 'wrong-token',
    });
    expect(deviceDb.getRemoteSyncState(hubUrl).lastPulledSeq).toBe(0);
  });
});
