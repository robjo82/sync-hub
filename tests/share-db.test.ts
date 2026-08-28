import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Db } from '../src/core/db.js';

describe('Db - Shared Threads', () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `sync-hub-share-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = new Db(dbPath);

    // Create a dummy project and thread
    db.upsertProject({
      id: 'proj-1',
      name: 'Test Project',
      canonicalPath: '/tmp/test',
      aliases: { paths: [], claudeSlugs: ['test'], codexCwds: ['test'] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    db.upsertThread({
      id: 'thread-1',
      projectId: 'proj-1',
      title: 'Discussion sur l architecture',
      originEngine: 'claude-code',
      engineIds: { 'claude-code': 'cc-1' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0, status: 'active',
    });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  });

  it('creates and retrieves a shared thread by token', () => {
    const shared = db.createSharedThread({
      threadId: 'thread-1',
      title: 'Mon extrait public',
    });

    expect(shared.id).toBeDefined();
    expect(shared.threadId).toBe('thread-1');
    expect(shared.shareToken).toBeDefined();
    expect(shared.shareToken.length).toBeGreaterThan(16);
    expect(shared.title).toBe('Mon extrait public');
    expect(shared.isActive).toBe(true);
    expect(shared.viewCount).toBe(0);

    const retrieved = db.getSharedThreadByToken(shared.shareToken);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(shared.id);
    expect(retrieved?.title).toBe('Mon extrait public');
  });

  it('handles expiration correctly', () => {
    // Expired in the past
    const expiredPast = new Date(Date.now() - 3600_000).toISOString();
    const sharedExpired = db.createSharedThread({
      threadId: 'thread-1',
      expiresAt: expiredPast,
    });

    // Default getter should reject expired
    expect(db.getSharedThreadByToken(sharedExpired.shareToken)).toBeUndefined();
    // With allowExpired option it should return it
    expect(db.getSharedThreadByToken(sharedExpired.shareToken, { allowExpired: true })).toBeDefined();

    // Future expiration should be valid
    const futureExp = new Date(Date.now() + 86400_000).toISOString();
    const sharedFuture = db.createSharedThread({
      threadId: 'thread-1',
      expiresAt: futureExp,
    });
    expect(db.getSharedThreadByToken(sharedFuture.shareToken)).toBeDefined();
  });

  it('handles deactivation / revocation', () => {
    const shared = db.createSharedThread({ threadId: 'thread-1' });
    expect(db.getSharedThreadByToken(shared.shareToken)).toBeDefined();

    // Deactivate
    db.updateSharedThread(shared.id, { isActive: false });
    expect(db.getSharedThreadByToken(shared.shareToken)).toBeUndefined();
    expect(db.getSharedThreadByToken(shared.shareToken, { allowInactive: true })).toBeDefined();

    // Reactivate
    db.updateSharedThread(shared.id, { isActive: true });
    expect(db.getSharedThreadByToken(shared.shareToken)).toBeDefined();
  });

  it('increments view count and updates last_viewed_at', () => {
    const shared = db.createSharedThread({ threadId: 'thread-1' });
    expect(shared.viewCount).toBe(0);
    expect(shared.lastViewedAt).toBeNull();

    db.incrementSharedThreadViewCount(shared.shareToken);

    const updated = db.getSharedThreadById(shared.id);
    expect(updated?.viewCount).toBe(1);
    expect(updated?.lastViewedAt).toBeDefined();

    db.incrementSharedThreadViewCount(shared.shareToken);
    const updated2 = db.getSharedThreadById(shared.id);
    expect(updated2?.viewCount).toBe(2);
  });

  it('lists shares for a thread and deletes a share', () => {
    const s1 = db.createSharedThread({ threadId: 'thread-1', title: 'Lien 1' });
    const s2 = db.createSharedThread({ threadId: 'thread-1', title: 'Lien 2' });

    const list = db.listSharedThreadsForThread('thread-1');
    expect(list.length).toBe(2);
    expect(list.map((s) => s.id)).toContain(s1.id);
    expect(list.map((s) => s.id)).toContain(s2.id);

    // Delete s1
    const deleted = db.deleteSharedThread(s1.id);
    expect(deleted).toBe(true);

    const listAfter = db.listSharedThreadsForThread('thread-1');
    expect(listAfter.length).toBe(1);
    expect(listAfter[0].id).toBe(s2.id);
  });

  it('cascades deletion when the underlying thread is deleted', () => {
    const shared = db.createSharedThread({ threadId: 'thread-1' });
    expect(db.getSharedThreadById(shared.id)).toBeDefined();

    // Delete thread
    db.deleteThread('thread-1');
    expect(db.getSharedThreadById(shared.id)).toBeUndefined();
  });
});
