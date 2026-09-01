import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import { hashPassword, hashSessionToken, generateSessionToken } from '../src/core/crypto.js';
import type { WatchHandle } from '../src/core/watch.js';

let dir: string;
let db: Db;
let app: FastifyInstance;
let aliceCookie: Record<string, string>;
let bobCookie: Record<string, string>;
let alice: { id: string };
let bob: { id: string };

function fakeWatchHandle(): WatchHandle {
  return { isActive: () => true, ready: () => Promise.resolve(), close: async () => {} };
}

async function makeUser(email: string, name: string, role?: 'admin' | 'member') {
  const user = db.createUser({ email, displayName: name, passwordHash: await hashPassword('motdepasse-solide'), role });
  const token = generateSessionToken();
  db.createSession({ userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  return { user, cookie: { cookie: `sync_hub_session=${token}` } };
}

function seedProject(id: string, ownerId: string, name: string) {
  const now = new Date().toISOString();
  db.upsertProject({ id, name, canonicalPath: `/tmp/${id}`, aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
  db.setProjectOwner(id, ownerId);
  db.upsertThread({
    id: `${id}-thread`,
    projectId: id,
    title: `Fil de ${name}`,
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  });
  db.insertMessage({
    id: `${id}-msg`,
    threadId: `${id}-thread`,
    projectId: id,
    sourceEngine: 'claude-code',
    role: 'user',
    content: `contenu confidentiel de ${name}`,
    timestamp: now,
    sequence: 0,
    hash: `${id}-hash`,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-sharing-'));
  db = new Db(join(dir, 'hub.sqlite'));
  const a = await makeUser('alice@ekonum.fr', 'Alice', 'admin');
  const b = await makeUser('bob@ekonum.fr', 'Bob');
  alice = a.user;
  bob = b.user;
  aliceCookie = a.cookie;
  bobCookie = b.cookie;
  seedProject('proj-alice', alice.id, 'Alice');
  seedProject('proj-bob', bob.id, 'Bob');

  app = createApp({
    db,
    registry: new ProjectRegistry(db),
    watchHandle: fakeWatchHandle(),
    rescan: vi.fn(),
    archiveRoots: { syncHubArchiveRoot: join(dir, 'archive'), codexArchiveRoot: join(dir, 'codex-archive') },
    importsDir: join(dir, 'imports'),
  });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Project visibility between colleagues', () => {
  it('each account only lists its own projects', async () => {
    const forAlice = await app.inject({ method: 'GET', url: '/api/projects', headers: aliceCookie });
    expect(forAlice.json().map((p: any) => p.id)).toEqual(['proj-alice']);

    const forBob = await app.inject({ method: 'GET', url: '/api/projects', headers: bobCookie });
    expect(forBob.json().map((p: any) => p.id)).toEqual(['proj-bob']);
  });

  it("answers 404 — not 403 — for someone else's project, so a probe cannot enumerate what exists", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/proj-alice', headers: bobCookie });
    expect(res.statusCode).toBe(404);
  });

  it("does not serve another account's threads or verbatim messages", async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects/proj-alice/threads', headers: bobCookie })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/threads/proj-alice-thread', headers: bobCookie })).statusCode).toBe(404);

    const messages = await app.inject({ method: 'GET', url: '/api/threads/proj-alice-thread/messages', headers: bobCookie });
    expect(messages.statusCode).toBe(404);
    expect(messages.body).not.toContain('contenu confidentiel');
  });

  it('search does not leak across accounts — it reads every project at once, so it needs its own guard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=confidentiel', headers: bobCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: any) => r.message.projectId)).toEqual(['proj-bob']);
    expect(res.body).not.toContain('contenu confidentiel de Alice');
  });
});

describe('Sharing a project', () => {
  it('makes it readable by the invitee, without transferring ownership', async () => {
    const shared = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-alice/shares',
      headers: aliceCookie,
      payload: { email: 'bob@ekonum.fr' },
    });
    expect(shared.statusCode).toBe(200);

    const forBob = await app.inject({ method: 'GET', url: '/api/projects', headers: bobCookie });
    expect(forBob.json().map((p: any) => p.id).sort()).toEqual(['proj-alice', 'proj-bob']);

    const messages = await app.inject({ method: 'GET', url: '/api/threads/proj-alice-thread/messages', headers: bobCookie });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages[0].content).toBe('contenu confidentiel de Alice');

    // Bob can read it but it is not his: he cannot pass it on.
    const reshare = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-alice/shares',
      headers: bobCookie,
      payload: { email: 'alice@ekonum.fr' },
    });
    expect(reshare.statusCode).toBe(404);
  });

  it('revoking takes the access back', async () => {
    await app.inject({ method: 'POST', url: '/api/projects/proj-alice/shares', headers: aliceCookie, payload: { email: 'bob@ekonum.fr' } });
    expect((await app.inject({ method: 'GET', url: '/api/projects/proj-alice', headers: bobCookie })).statusCode).toBe(200);

    const revoked = await app.inject({ method: 'POST', url: `/api/projects/proj-alice/shares/${bob.id}/revoke`, headers: aliceCookie });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/projects/proj-alice', headers: bobCookie })).statusCode).toBe(404);
  });

  it('refuses to share a project the caller does not own', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-bob/shares',
      headers: aliceCookie,
      payload: { email: 'bob@ekonum.fr' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports an unknown email rather than silently doing nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-alice/shares',
      headers: aliceCookie,
      payload: { email: 'personne@ekonum.fr' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('user_not_found');
  });
});
