import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/core/db.js';
import { hashPassword, hashSessionToken, generateSessionToken } from '../src/core/crypto.js';

describe('Auth database operations', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sync-hub-auth-test-'));
    db = new Db(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and retrieves user', async () => {
    const passwordHash = await hashPassword('AdminPass123!');
    const user = db.createUser({
      email: 'Admin@Ekonum.fr', // tests lowercase normalization
      displayName: 'Robin Admin',
      passwordHash,
      role: 'admin',
    });

    expect(user.id).toBeDefined();
    expect(user.email).toBe('admin@ekonum.fr');
    expect(user.displayName).toBe('Robin Admin');
    expect(user.role).toBe('admin');
    expect(db.countUsers()).toBe(1);

    const retrievedById = db.getUserById(user.id);
    expect(retrievedById).toEqual(user);

    const retrievedByEmail = db.getUserByEmail('ADMIN@ekonum.fr');
    expect(retrievedByEmail?.passwordHash).toBe(passwordHash);
  });

  it('enforces email uniqueness', async () => {
    const hash = await hashPassword('pass');
    db.createUser({ email: 'test@example.com', displayName: 'User 1', passwordHash: hash });

    expect(() => {
      db.createUser({ email: 'test@example.com', displayName: 'User 2', passwordHash: hash });
    }).toThrow();
  });

  it('lists, updates, and deletes users', async () => {
    const hash = await hashPassword('pass');
    const u1 = db.createUser({ email: 'u1@example.com', displayName: 'User One', passwordHash: hash, role: 'admin' });
    const u2 = db.createUser({ email: 'u2@example.com', displayName: 'User Two', passwordHash: hash, role: 'member' });

    expect(db.listUsers()).toHaveLength(2);

    const updated = db.updateUser(u2.id, { displayName: 'User Two Updated', role: 'admin' });
    expect(updated?.displayName).toBe('User Two Updated');
    expect(updated?.role).toBe('admin');

    const deleted = db.deleteUser(u1.id);
    expect(deleted).toBe(true);
    expect(db.countUsers()).toBe(1);
    expect(db.getUserById(u1.id)).toBeUndefined();
  });

  it('creates, retrieves, and expires sessions', async () => {
    const hash = await hashPassword('pass');
    const user = db.createUser({ email: 'session@example.com', displayName: 'Session User', passwordHash: hash });

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const futureDate = new Date(Date.now() + 86400 * 1000).toISOString();

    const session = db.createSession({
      userId: user.id,
      tokenHash,
      expiresAt: futureDate,
      userAgent: 'Mozilla/5.0 Vitest',
      ip: '127.0.0.1',
    });

    expect(session.id).toBeDefined();

    const retrieved = db.getSessionByTokenHash(tokenHash);
    expect(retrieved).toBeDefined();
    expect(retrieved?.user.id).toBe(user.id);
    expect(retrieved?.session.userAgent).toBe('Mozilla/5.0 Vitest');

    // Deleting session
    db.deleteSessionByTokenHash(tokenHash);
    expect(db.getSessionByTokenHash(tokenHash)).toBeUndefined();

    // Expired session handling
    const expiredToken = generateSessionToken();
    const expiredTokenHash = hashSessionToken(expiredToken);
    const pastDate = new Date(Date.now() - 1000).toISOString();

    db.createSession({
      userId: user.id,
      tokenHash: expiredTokenHash,
      expiresAt: pastDate,
    });

    // getSessionByTokenHash filters out expired sessions
    expect(db.getSessionByTokenHash(expiredTokenHash)).toBeUndefined();

    // cleanExpiredSessions deletes the row
    const cleaned = db.cleanExpiredSessions();
    expect(cleaned).toBe(1);
  });
});
