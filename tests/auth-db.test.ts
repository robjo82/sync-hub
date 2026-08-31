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

describe('API tokens — the machine credentials the sync path authenticates with', () => {
  let tmpDir: string;
  let db: Db;
  let userId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sync-hub-apitoken-test-'));
    db = new Db(join(tmpDir, 'test.sqlite'));
    userId = db.createUser({
      email: 'robin@ekonum.fr',
      displayName: 'Robin',
      passwordHash: await hashPassword('motdepasse-solide'),
      role: 'admin',
    }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a token to its owner, so a push can be attributed to a real account', () => {
    const plaintext = generateSessionToken();
    db.createApiToken({ userId, tokenHash: hashSessionToken(plaintext), name: 'MacBook Robin' });

    const resolved = db.getUserByApiToken(hashSessionToken(plaintext));
    expect(resolved?.id).toBe(userId);
    expect(resolved?.email).toBe('robin@ekonum.fr');
  });

  it('does not resolve an unknown token', () => {
    expect(db.getUserByApiToken(hashSessionToken('jamais-émis'))).toBeUndefined();
  });

  it('stops resolving once revoked — this is what lets one machine be cut off alone', () => {
    const plaintext = generateSessionToken();
    const token = db.createApiToken({ userId, tokenHash: hashSessionToken(plaintext), name: 'Vieux portable' });
    expect(db.getUserByApiToken(hashSessionToken(plaintext))?.id).toBe(userId);

    expect(db.revokeApiToken(token.id, userId)).toBe(true);
    expect(db.getUserByApiToken(hashSessionToken(plaintext))).toBeUndefined();
    // Revoking twice is not an error the caller should have to special-case, but it changes nothing.
    expect(db.revokeApiToken(token.id, userId)).toBe(false);
  });

  it('refuses to revoke a token belonging to someone else', async () => {
    const other = db.createUser({
      email: 'collegue@ekonum.fr',
      displayName: 'Collègue',
      passwordHash: await hashPassword('un-autre-mot-de-passe'),
    });
    const plaintext = generateSessionToken();
    const token = db.createApiToken({ userId, tokenHash: hashSessionToken(plaintext), name: 'MacBook Robin' });

    expect(db.revokeApiToken(token.id, other.id)).toBe(false);
    expect(db.getUserByApiToken(hashSessionToken(plaintext))?.id).toBe(userId);
  });

  it('records last use, so a token nobody has used in months can be spotted and cleaned up', () => {
    const plaintext = generateSessionToken();
    const token = db.createApiToken({ userId, tokenHash: hashSessionToken(plaintext), name: 'CI' });
    expect(db.listApiTokens(userId).find((t) => t.id === token.id)?.lastUsedAt).toBeUndefined();

    db.getUserByApiToken(hashSessionToken(plaintext));
    expect(db.listApiTokens(userId).find((t) => t.id === token.id)?.lastUsedAt).toBeTruthy();
  });

  it('never stores the plaintext token anywhere', () => {
    const plaintext = generateSessionToken();
    db.createApiToken({ userId, tokenHash: hashSessionToken(plaintext), name: 'MacBook Robin' });

    const stored = db.listApiTokens(userId)[0];
    expect(stored.tokenHash).not.toBe(plaintext);
    expect(JSON.stringify(stored)).not.toContain(plaintext);
  });
});
