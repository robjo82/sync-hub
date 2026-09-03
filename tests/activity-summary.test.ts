import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { DEFAULT_KEYSTROKES_PER_MINUTE } from '../src/core/activity.js';

describe('getActivitySummary', () => {
  let dir: string;
  let db: Db;

  /** A user turn then a reply, `gapSeconds` apart, at `at`. */
  const exchange = (threadId: string, seq: number, at: string, userText: string, gapSeconds: number) => {
    const start = new Date(at).getTime();
    db.insertMessage({
      id: `${threadId}-u${seq}`, threadId, projectId: 'p1', sourceEngine: 'claude-code', role: 'user',
      content: userText, timestamp: new Date(start).toISOString(), sequence: seq, hash: `h-${threadId}-u${seq}`,
    });
    db.insertMessage({
      id: `${threadId}-a${seq}`, threadId, projectId: 'p1', sourceEngine: 'claude-code', role: 'assistant',
      content: 'réponse', timestamp: new Date(start + gapSeconds * 1000).toISOString(), sequence: seq + 1, hash: `h-${threadId}-a${seq}`,
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-activity-'));
    db = new Db(join(dir, 'hub.sqlite'));
    const now = '2026-09-01T08:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'Acritec', canonicalPath: join(dir, 'p1'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now, category: 'client' });
    db.upsertThread({ id: 't1', projectId: 'p1', title: 'T1', originEngine: 'claude-code', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures thinking as the interval before each reply', () => {
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Bonjour', 20);
    const s = db.getActivitySummary({});
    expect(s.totalThinkingMs).toBe(20_000);
  });

  it('caps typing by the time that actually passed between turns', () => {
    // Second user turn arrives 10s after the first reply, carrying 4,000 characters: at 40/min
    // that would be 100 minutes, so the estimate must collapse to the 10 seconds available.
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Bonjour', 20);
    db.insertMessage({
      id: 't1-u2', threadId: 't1', projectId: 'p1', sourceEngine: 'claude-code', role: 'user',
      content: 'x'.repeat(4000), timestamp: '2026-09-01T09:00:30.000Z', sequence: 2, hash: 'h-t1-u2',
    });

    const s = db.getActivitySummary({});
    expect(s.cappedMessageCount).toBe(1);
    // First message: capped at the 5-minute first-message ceiling isn't hit ("Bonjour" is short).
    // Second: exactly the 10s gap after the reply at 09:00:20.
    expect(s.totalTypingMs).toBeLessThanOrEqual(5 * 60_000 + 10_000);
    expect(s.totalTypingMs).toBeGreaterThan(0);
  });

  it('splits the day into hours so a working pattern is visible', () => {
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Question du matin', 30);
    exchange('t1', 2, '2026-09-01T14:00:00.000Z', 'Question de l’après-midi', 30);

    const s = db.getActivitySummary({});
    expect(s.byHour).toHaveLength(24);
    expect(s.byHour[9].messages).toBeGreaterThan(0);
    expect(s.byHour[14].messages).toBeGreaterThan(0);
    expect(s.byHour[3].messages).toBe(0);
  });

  it('groups by day, in order', () => {
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Jour un', 15);
    exchange('t1', 2, '2026-09-02T09:00:00.000Z', 'Jour deux', 15);

    const s = db.getActivitySummary({});
    expect(s.byDate.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('narrows to one project, one thread, one category', () => {
    const now = '2026-09-01T08:00:00.000Z';
    db.upsertProject({ id: 'p2', name: 'Perso', canonicalPath: join(dir, 'p2'), aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now, category: 'perso' });
    db.upsertThread({ id: 't2', projectId: 'p2', title: 'T2', originEngine: 'codex', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Sujet client', 20);
    db.insertMessage({
      id: 't2-u0', threadId: 't2', projectId: 'p2', sourceEngine: 'codex', role: 'user',
      content: 'Sujet perso', timestamp: '2026-09-01T10:00:00.000Z', sequence: 0, hash: 'h-t2-u0',
    });
    db.insertMessage({
      id: 't2-a0', threadId: 't2', projectId: 'p2', sourceEngine: 'codex', role: 'assistant',
      content: 'ok', timestamp: '2026-09-01T10:00:40.000Z', sequence: 1, hash: 'h-t2-a0',
    });

    expect(db.getActivitySummary({}).totalThinkingMs).toBe(60_000);
    expect(db.getActivitySummary({ projectId: 'p1' }).totalThinkingMs).toBe(20_000);
    expect(db.getActivitySummary({ threadId: 't2' }).totalThinkingMs).toBe(40_000);
    expect(db.getActivitySummary({ category: 'client' }).totalThinkingMs).toBe(20_000);
    expect(db.getActivitySummary({ category: 'perso' }).totalThinkingMs).toBe(40_000);
  });

  it('honours a date range', () => {
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Avant', 10);
    exchange('t1', 2, '2026-09-05T09:00:00.000Z', 'Après', 25);

    const s = db.getActivitySummary({ startDate: '2026-09-03' });
    expect(s.byDate.map((d) => d.date)).toEqual(['2026-09-05']);
  });

  it('reports the pace it used, and never divides by a zero one', () => {
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Bonjour', 10);
    expect(db.getActivitySummary({}).keystrokesPerMinute).toBe(DEFAULT_KEYSTROKES_PER_MINUTE);
    expect(db.getActivitySummary({ keystrokesPerMinute: 0 }).keystrokesPerMinute).toBe(0);
    expect(Number.isFinite(db.getActivitySummary({ keystrokesPerMinute: 0 }).totalTypingMs)).toBe(true);
  });

  it('does not carry a gap across two threads', () => {
    // t2's first message must not be measured against t1's last: they are different conversations,
    // and the gap between them is not work on either.
    const now = '2026-09-01T08:00:00.000Z';
    db.upsertThread({ id: 't2', projectId: 'p1', title: 'T2', originEngine: 'claude-code', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
    exchange('t1', 0, '2026-09-01T09:00:00.000Z', 'Fil un', 10);
    exchange('t2', 0, '2026-09-01T09:00:20.000Z', 'Fil deux', 10);

    // Two replies, 10s each; no third interval invented from the thread boundary.
    expect(db.getActivitySummary({}).totalThinkingMs).toBe(20_000);
  });
});

describe('typing pace per person', () => {
  it('defaults low, accepts a value, and returns to the default when cleared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-pace-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    try {
      const user = db.createUser({ email: 'r@ekonum.fr', displayName: 'Robin', passwordHash: 'peu-importe-ici', role: 'admin' });
      expect(db.getKeystrokesPerMinute(user.id)).toBe(DEFAULT_KEYSTROKES_PER_MINUTE);
      db.setKeystrokesPerMinute(user.id, 120);
      expect(db.getKeystrokesPerMinute(user.id)).toBe(120);
      db.setKeystrokesPerMinute(user.id, null);
      expect(db.getKeystrokesPerMinute(user.id)).toBe(DEFAULT_KEYSTROKES_PER_MINUTE);
      // An unknown user must not throw — the local instance has no accounts at all.
      expect(db.getKeystrokesPerMinute(undefined)).toBe(DEFAULT_KEYSTROKES_PER_MINUTE);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the typing pace actually takes effect on a local instance', () => {
  it('is stored and applied for the synthetic user that has no row in users', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Db } = await import('../src/core/db.js');

    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-localpace-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    try {
      // 'local-admin' is what the local instance presents when authentication is off. It exists
      // nowhere in `users`, so an UPDATE there matched no row: the endpoint answered ok and the
      // pace stayed at 40 for ever.
      db.setKeystrokesPerMinute('local-admin', 120);
      expect(db.getKeystrokesPerMinute('local-admin')).toBe(120);
      db.setKeystrokesPerMinute('local-admin', null);
      expect(db.getKeystrokesPerMinute('local-admin')).toBe(40);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
