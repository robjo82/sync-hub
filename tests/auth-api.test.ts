import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { createApp } from '../src/server/app.js';
import type { FastifyInstance } from 'fastify';

describe('Auth API and RBAC', () => {
  let tmpDir: string;
  let db: Db;
  let registry: ProjectRegistry;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sync-hub-auth-api-test-'));
    db = new Db(join(tmpDir, 'test.sqlite'));
    registry = new ProjectRegistry(db);

    app = createApp({
      db,
      registry,
      watchHandle: { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} },
      rescan: () => {},
      archiveRoots: { syncHubArchiveRoot: join(tmpDir, 'archive') },
      importsDir: join(tmpDir, 'imports'),
      authDisabled: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports setupRequired: true initially, then false after setup', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.setupRequired).toBe(true);
    expect(body1.authEnabled).toBe(false);

    // Initial setup
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'admin@ekonum.fr', displayName: 'Robin Admin', password: 'Password1234!' },
    });
    expect(setupRes.statusCode).toBe(200);
    const setupData = setupRes.json();
    expect(setupData.user.role).toBe('admin');
    expect(setupData.token).toBeDefined();

    // Re-checking status
    const res2 = await app.inject({ method: 'GET', url: '/api/auth/status' });
    const body2 = res2.json();
    expect(body2.setupRequired).toBe(false);
    expect(body2.authEnabled).toBe(true);

    // Setup cannot be called a second time
    const secondSetup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'hacker@example.com', displayName: 'Hacker', password: 'Password1234!' },
    });
    expect(secondSetup.statusCode).toBe(403);
  });

  it('protects API routes once users exist, accepts valid token or cookie', async () => {
    // 1. Setup initial admin
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'admin@ekonum.fr', displayName: 'Robin Admin', password: 'Password1234!' },
    });
    const { token } = setupRes.json();

    // 2. Unauthenticated request to /api/projects is rejected with 401
    const unauthRes = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(unauthRes.statusCode).toBe(401);

    // 3. Request with Bearer header succeeds
    const authHeaderRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authHeaderRes.statusCode).toBe(200);

    // 4. Request with cookie succeeds
    const cookieRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { sync_hub_session: token },
    });
    expect(cookieRes.statusCode).toBe(200);
  });

  it('handles login, me, and logout correctly', async () => {
    // Setup admin
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'admin@ekonum.fr', displayName: 'Robin Admin', password: 'Password1234!' },
    });

    // Login with wrong password
    const wrongPassRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@ekonum.fr', password: 'WrongPassword' },
    });
    expect(wrongPassRes.statusCode).toBe(401);

    // Login with correct password
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@ekonum.fr', password: 'Password1234!' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token, user } = loginRes.json();
    expect(user.email).toBe('admin@ekonum.fr');
    expect(token).toBeDefined();

    // Check /api/auth/me
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.id).toBe(user.id);

    // Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Subsequent call to /api/auth/me is 401
    const meAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meAfterLogout.statusCode).toBe(401);
  });

  it('enforces RBAC: admin can manage users, member cannot', async () => {
    // Setup admin
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'admin@ekonum.fr', displayName: 'Admin', password: 'Password1234!' },
    });
    const adminToken = setupRes.json().token;

    // Admin creates a member
    const createMemberRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'member@ekonum.fr', displayName: 'Member One', password: 'MemberPass1234!', role: 'member' },
    });
    expect(createMemberRes.statusCode).toBe(200);
    const memberUser = createMemberRes.json();
    expect(memberUser.role).toBe('member');

    // Member logs in
    const memberLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'member@ekonum.fr', password: 'MemberPass1234!' },
    });
    const memberToken = memberLogin.json().token;

    // Member tries to list users -> 403 Forbidden
    const memberListUsers = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(memberListUsers.statusCode).toBe(403);

    // Member tries to create another user -> 403 Forbidden
    const memberCreateUser = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { email: 'hack@ekonum.fr', displayName: 'Hacker', password: 'Password1234!' },
    });
    expect(memberCreateUser.statusCode).toBe(403);

    // Member can update their own displayName
    const memberUpdateSelf = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberUser.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { displayName: 'Member One Updated' },
    });
    expect(memberUpdateSelf.statusCode).toBe(200);
    expect(memberUpdateSelf.json().displayName).toBe('Member One Updated');

    // Member cannot elevate own role to admin -> 403 Forbidden
    const memberElevate = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberUser.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { role: 'admin' },
    });
    expect(memberElevate.statusCode).toBe(403);

    // Admin tries to delete the last admin -> 400 Bad Request
    const adminUser = setupRes.json().user;
    const deleteAdminRes = await app.inject({
      method: 'DELETE',
      url: `/api/users/${adminUser.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleteAdminRes.statusCode).toBe(400);

    // Admin deletes member -> 200 OK
    const deleteMemberRes = await app.inject({
      method: 'DELETE',
      url: `/api/users/${memberUser.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleteMemberRes.statusCode).toBe(200);
  });
});
