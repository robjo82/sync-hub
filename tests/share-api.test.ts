import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import { hashPassword } from '../src/core/crypto.js';
import type { FastifyInstance } from 'fastify';

describe('API - Thread Sharing & Public Links', () => {
  let db: Db;
  let dbPath: string;
  let registry: ProjectRegistry;
  let app: FastifyInstance;
  let memberCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `sync-hub-share-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = new Db(dbPath);
    registry = new ProjectRegistry(db);

    // Setup Admin user
    const adminPass = await hashPassword('AdminPass123!');
    db.createUser({
      email: 'admin@sync-hub.test',
      displayName: 'Admin User',
      passwordHash: adminPass,
      role: 'admin',
    });

    // Setup Member user
    const memberPass = await hashPassword('MemberPass123!');
    db.createUser({
      email: 'member@sync-hub.test',
      displayName: 'Member User',
      passwordHash: memberPass,
      role: 'member',
    });

    // Create dummy project and thread
    db.upsertProject({
      id: 'proj-1',
      name: 'Ekonum Diagnostic',
      canonicalPath: '/tmp/ekonum',
      aliases: { paths: [], claudeSlugs: ['ekonum'], codexCwds: ['ekonum'] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    db.upsertThread({
      id: 'thread-1',
      projectId: 'proj-1',
      title: 'Avant-vente Odoo Acritec',
      originEngine: 'claude-code',
      engineIds: { 'claude-code': 'cc-1' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0, status: 'active',
    });

    db.insertMessage({
      id: 'msg-1',
      threadId: 'thread-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'user',
      content: 'Bonjour, peux-tu analyser ce diagnostic ?',
      timestamp: new Date().toISOString(),
      sequence: 1,
      hash: 'hash-1',
    });

    db.insertMessage({
      id: 'msg-2',
      threadId: 'thread-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'assistant',
      content: 'Voici l analyse complète :\n```python\nprint("Odoo 19")\n```',
      timestamp: new Date().toISOString(),
      sequence: 2,
      hash: 'hash-2',
    });

    app = createApp({
      db,
      registry,
      watchHandle: { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} },
      rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: '/tmp/archived' },
      importsDir: '/tmp/imports',
    });

    await app.ready();

    // Login admin
    const adminLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@sync-hub.test', password: 'AdminPass123!' },
    });
    adminCookie = adminLoginRes.headers['set-cookie'] as string;

    // Login member
    const memberLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'member@sync-hub.test', password: 'MemberPass123!' },
    });
    memberCookie = memberLoginRes.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    if (app) await app.close();
    db.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it('rejects creating a share without authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/shares',
      payload: { title: 'Partage public' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows authenticated member to create and list shares for a thread', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/shares',
      headers: { cookie: memberCookie },
      payload: { title: 'Partage Démo Client' },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.id).toBeDefined();
    expect(created.shareToken).toBeDefined();
    expect(created.title).toBe('Partage Démo Client');
    expect(created.isActive).toBe(true);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/shares',
      headers: { cookie: memberCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);
  });

  it('allows unauthenticated public access to GET /api/share/:token and increments views', async () => {
    // Create share
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/shares',
      headers: { cookie: adminCookie },
      payload: { title: 'Diagnostic Public' },
    });
    const { shareToken } = JSON.parse(createRes.body);

    // Call public endpoint WITHOUT any cookies or auth headers
    const publicRes = await app.inject({
      method: 'GET',
      url: `/api/share/${shareToken}`,
    });

    expect(publicRes.statusCode).toBe(200);
    const data = JSON.parse(publicRes.body);
    expect(data.sharedThread).toBeDefined();
    expect(data.sharedThread.title).toBe('Diagnostic Public');
    expect(data.thread.id).toBe('thread-1');
    expect(data.thread.title).toBe('Avant-vente Odoo Acritec');
    expect(data.messages.length).toBe(2);
    expect(data.project.name).toBe('Ekonum Diagnostic');

    // Verify view count in DB
    const shareInDb = db.getSharedThreadByToken(shareToken);
    expect(shareInDb?.viewCount).toBe(1);
  });

  it('returns 404 for deactivated or expired public links', async () => {
    // Create deactivated share
    const shared = db.createSharedThread({ threadId: 'thread-1' });
    db.updateSharedThread(shared.id, { isActive: false });

    const res = await app.inject({
      method: 'GET',
      url: `/api/share/${shared.shareToken}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows creator or admin to update and delete a share', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/shares',
      headers: { cookie: memberCookie },
      payload: { title: 'Titre Initial' },
    });
    const created = JSON.parse(createRes.body);

    // Member updates their share
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/shares/${created.id}`,
      headers: { cookie: memberCookie },
      payload: { title: 'Nouveau Titre', isActive: false },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.title).toBe('Nouveau Titre');
    expect(updated.isActive).toBe(false);

    // Admin deletes the share
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/shares/${created.id}`,
      headers: { cookie: adminCookie },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.body).ok).toBe(true);

    expect(db.getSharedThreadById(created.id)).toBeUndefined();
  });
});
