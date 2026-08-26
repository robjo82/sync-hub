import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import { runPushCycle } from '../src/core/sync-push-client.js';
import type { WatchHandle } from '../src/core/watch.js';
import type { Message, Project } from '../src/types.js';

let localDir: string;
let remoteDir: string;
let localDb: Db;
let remoteDb: Db;
let remoteApp: FastifyInstance;
let remoteUrl: string;
const REMOTE_TOKEN = 'jeton-de-test';

function fakeWatchHandle(): WatchHandle {
  return { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-local',
    name: 'Local',
    canonicalPath: '/Users/robin/Projets/local',
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
    projectId: 'proj-local',
    sourceEngine: 'claude-code',
    role: 'user',
    content: 'Bonjour depuis la machine locale',
    timestamp: now,
    sequence: 0,
    hash: 'h1',
    ...overrides,
  };
}

beforeEach(async () => {
  localDir = mkdtempSync(join(tmpdir(), 'sync-hub-push-local-'));
  remoteDir = mkdtempSync(join(tmpdir(), 'sync-hub-push-remote-'));
  localDb = new Db(join(localDir, 'hub.sqlite'));
  remoteDb = new Db(join(remoteDir, 'hub.sqlite'));

  localDb.upsertProject(project());
  localDb.upsertThread({
    id: 't1',
    projectId: 'proj-local',
    title: 'Fil local',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });

  const remoteRegistry = new ProjectRegistry(remoteDb);
  remoteApp = createApp({
    db: remoteDb,
    registry: remoteRegistry,
    watchHandle: fakeWatchHandle(),
    rescan: () => {},
    archiveRoots: { syncHubArchiveRoot: join(remoteDir, 'archive'), codexArchiveRoot: join(remoteDir, 'codex-archive') },
    importsDir: join(remoteDir, 'imports'),
    remoteToken: REMOTE_TOKEN,
  });
  const address = await remoteApp.listen({ port: 0, host: '127.0.0.1' });
  remoteUrl = address;
});

afterEach(async () => {
  await remoteApp.close();
  localDb.close();
  remoteDb.close();
  rmSync(localDir, { recursive: true, force: true });
  rmSync(remoteDir, { recursive: true, force: true });
});

describe('runPushCycle', () => {
  it('pushes every not-yet-pushed message to the remote, and the remote actually has them afterward', async () => {
    localDb.insertMessage(message({ id: 'm1', hash: 'h1', content: 'premier message' }));
    localDb.insertMessage(message({ id: 'm2', hash: 'h2', content: 'second message' }));

    await runPushCycle(localDb, { remoteUrl, remoteToken: REMOTE_TOKEN });

    expect(remoteDb.getThread('t1')).toBeDefined();
    expect(remoteDb.getMessagesForThread('t1').map((m) => m.content)).toEqual(['premier message', 'second message']);
  });

  it('advances the local watermark on success, so a second cycle with no new messages pushes nothing new', async () => {
    localDb.insertMessage(message({ id: 'm1', hash: 'h1' }));
    await runPushCycle(localDb, { remoteUrl, remoteToken: REMOTE_TOKEN });
    const stateAfterFirst = localDb.getRemoteSyncState(remoteUrl);
    expect(stateAfterFirst.lastPushedSeq).toBeGreaterThan(0);

    await runPushCycle(localDb, { remoteUrl, remoteToken: REMOTE_TOKEN });
    expect(localDb.getRemoteSyncState(remoteUrl).lastPushedSeq).toBe(stateAfterFirst.lastPushedSeq);
    expect(remoteDb.getMessagesForThread('t1')).toHaveLength(1); // no duplicate from the second, no-op cycle
  });

  it('sends multiple sequential batches when there are more messages than batchSize', async () => {
    for (let i = 0; i < 5; i++) {
      localDb.insertMessage(message({ id: `m${i}`, hash: `h${i}`, content: `message ${i}` }));
    }

    await runPushCycle(localDb, { remoteUrl, remoteToken: REMOTE_TOKEN, batchSize: 2 });

    expect(remoteDb.getMessagesForThread('t1')).toHaveLength(5);
    // The watermark should reflect having consumed everything, not just the first batch.
    const remoteMessages = remoteDb.getMessagesForThread('t1');
    expect(remoteMessages.map((m) => m.content)).toEqual(['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
  });

  it('does not advance the watermark when the remote rejects the batch, so the next call retries from the same point', async () => {
    localDb.insertMessage(message({ id: 'm1', hash: 'h1' }));

    // Wrong token — the remote will 401 every attempt.
    await runPushCycle(localDb, { remoteUrl, remoteToken: 'mauvais-jeton' });
    expect(localDb.getRemoteSyncState(remoteUrl).lastPushedSeq).toBe(0);
    expect(remoteDb.getMessagesForThread('t1')).toHaveLength(0);

    // Retrying with the right token from here picks up exactly where it left off.
    await runPushCycle(localDb, { remoteUrl, remoteToken: REMOTE_TOKEN });
    expect(remoteDb.getMessagesForThread('t1')).toHaveLength(1);
  });

  it('a network error (unreachable remote) leaves the watermark untouched', async () => {
    localDb.insertMessage(message({ id: 'm1', hash: 'h1' }));
    await runPushCycle(localDb, { remoteUrl: 'http://127.0.0.1:1', remoteToken: REMOTE_TOKEN });
    expect(localDb.getRemoteSyncState('http://127.0.0.1:1').lastPushedSeq).toBe(0);
  });
});
