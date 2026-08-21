import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Db } from '../src/core/db.js';
import type { Message, Project } from '../src/types.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-db-'));
  db = new Db(join(dir, 'hub.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-test',
    name: 'Test',
    canonicalPath: '/Users/robin/Projets/test',
    aliases: { paths: [], claudeSlugs: ['-Users-robin-Projets-test'], codexCwds: ['/Users/robin/Projets/test'] },
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    projectId: 'proj-test',
    sourceEngine: 'claude-code',
    role: 'user',
    content: 'Bonjour',
    timestamp: now,
    sequence: 0,
    hash: 'hash-1',
    ...overrides,
  };
}

describe('Db projects', () => {
  it('round-trips a project through upsert/getProjects', () => {
    db.upsertProject(makeProject());
    const projects = db.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('proj-test');
    expect(projects[0].aliases.claudeSlugs).toEqual(['-Users-robin-Projets-test']);
  });

  it('updates in place on conflict instead of duplicating', () => {
    db.upsertProject(makeProject());
    db.upsertProject(makeProject({ name: 'Renamed' }));
    expect(db.getProjects()).toHaveLength(1);
    expect(db.getProject('proj-test')?.name).toBe('Renamed');
  });
});

describe('Db.setProjectOrder', () => {
  beforeEach(() => {
    const older = '2026-01-01T00:00:00Z';
    const newer = '2026-02-01T00:00:00Z';
    db.upsertProject(makeProject({ id: 'proj-old', name: 'Old activity', canonicalPath: '/tmp/old', lastActiveAt: older }));
    db.upsertProject(makeProject({ id: 'proj-new', name: 'New activity', canonicalPath: '/tmp/new', lastActiveAt: newer }));
  });

  it('with no manual order set, falls back to last-activity order (most recent first) as before', () => {
    expect(db.getProjects().map((p) => p.id)).toEqual(['proj-new', 'proj-old']);
  });

  it('a manually-set order overrides last-activity order entirely', () => {
    db.setProjectOrder(['proj-old', 'proj-new']);
    expect(db.getProjects().map((p) => p.id)).toEqual(['proj-old', 'proj-new']);
    expect(db.getProject('proj-old')?.sortOrder).toBe(0);
    expect(db.getProject('proj-new')?.sortOrder).toBe(1);
  });

  it('a project never included in setProjectOrder (e.g. discovered later) sorts after every manually-ordered project', () => {
    db.setProjectOrder(['proj-old']); // only one project manually positioned
    db.upsertProject(makeProject({ id: 'proj-fresh', name: 'Fresh', canonicalPath: '/tmp/fresh', lastActiveAt: '2026-03-01T00:00:00Z' }));

    const ids = db.getProjects().map((p) => p.id);
    expect(ids[0]).toBe('proj-old'); // manually ordered, even though it's the least recently active
    expect(ids.slice(1).sort()).toEqual(['proj-fresh', 'proj-new']); // the rest, by activity
  });
});

describe('Db.renameProject', () => {
  it('updates the display name in place', () => {
    db.upsertProject(makeProject());
    db.renameProject('proj-test', 'C00125 - Acritec');
    expect(db.getProject('proj-test')?.name).toBe('C00125 - Acritec');
  });
});

describe('Db.setProjectCategory', () => {
  it('sets a free-form category, survives a re-upsert, and null clears it', () => {
    db.upsertProject(makeProject());
    db.setProjectCategory('proj-test', 'client');
    expect(db.getProject('proj-test')?.category).toBe('client');

    // A routine re-ingest (upsertProject on conflict) must not silently wipe a manually-set category.
    db.upsertProject(makeProject());
    expect(db.getProject('proj-test')?.category).toBe('client');

    db.setProjectCategory('proj-test', null);
    expect(db.getProject('proj-test')?.category).toBeNull();
  });

  it('registers a brand-new category name so it shows up in listCategories even before any other project uses it', () => {
    db.upsertProject(makeProject());
    db.setProjectCategory('proj-test', 'recherche');
    expect(db.listCategories().map((c) => c.name)).toContain('recherche');
  });
});

describe('Db categories', () => {
  it('seeds the minimum set (ekonum, client, perso) on a fresh database, with zero projects each', () => {
    const names = db.listCategories().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['ekonum', 'client', 'perso']));
    expect(db.listCategories().find((c) => c.name === 'perso')?.projectCount).toBe(0);
  });

  it('createCategory is idempotent', () => {
    db.createCategory('client');
    db.createCategory('client');
    expect(db.listCategories().filter((c) => c.name === 'client')).toHaveLength(1);
  });

  it('listCategories counts real project usage', () => {
    db.upsertProject(makeProject({ id: 'proj-a', canonicalPath: '/tmp/a' }));
    db.upsertProject(makeProject({ id: 'proj-b', canonicalPath: '/tmp/b' }));
    db.setProjectCategory('proj-a', 'client');
    db.setProjectCategory('proj-b', 'client');
    expect(db.listCategories().find((c) => c.name === 'client')?.projectCount).toBe(2);
  });

  it('renameCategory updates the category itself and every project using it, atomically', () => {
    db.upsertProject(makeProject({ id: 'proj-a', canonicalPath: '/tmp/a' }));
    db.setProjectCategory('proj-a', 'client');
    db.renameCategory('client', 'clients');
    expect(db.listCategories().map((c) => c.name)).not.toContain('client');
    expect(db.listCategories().map((c) => c.name)).toContain('clients');
    expect(db.getProject('proj-a')?.category).toBe('clients');
  });

  it('renameCategory refuses to collide with an existing different category', () => {
    expect(() => db.renameCategory('client', 'perso')).toThrow();
  });

  it('deleteCategory removes it and clears the category on every project that used it, returning the affected count', () => {
    db.upsertProject(makeProject({ id: 'proj-a', canonicalPath: '/tmp/a' }));
    db.upsertProject(makeProject({ id: 'proj-b', canonicalPath: '/tmp/b' }));
    db.setProjectCategory('proj-a', 'client');
    db.setProjectCategory('proj-b', 'client');
    const affected = db.deleteCategory('client');
    expect(affected).toBe(2);
    expect(db.listCategories().map((c) => c.name)).not.toContain('client');
    expect(db.getProject('proj-a')?.category).toBeNull();
    expect(db.getProject('proj-b')?.category).toBeNull();
  });
});

describe('Db.mergeProjects', () => {
  beforeEach(() => {
    db.upsertProject(makeProject({ id: 'proj-source', name: 'Source', canonicalPath: '/tmp/source', aliases: { paths: [], claudeSlugs: ['slug-a'], codexCwds: [] } }));
    db.upsertProject(makeProject({ id: 'proj-target', name: 'Target', canonicalPath: '/tmp/target', aliases: { paths: [], claudeSlugs: [], codexCwds: ['cwd-b'] } }));
    db.upsertThread({
      id: 'thread-source',
      projectId: 'proj-source',
      title: 'Fil source',
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    db.insertMessage(makeMessage({ id: 'msg-source', threadId: 'thread-source', projectId: 'proj-source', hash: 'hash-source' }));
    db.upsertMemory({
      id: 'mem-source',
      projectId: 'proj-source',
      sourceEngine: 'claude-code',
      category: 'project',
      filePath: '/tmp/source/MEMORY.md',
      content: 'note',
      lastModifiedAt: new Date().toISOString(),
    });
    db.upsertArtifact({
      id: 'art-source',
      projectId: 'proj-source',
      threadId: 'thread-source',
      title: 'doc',
      filePath: '/tmp/source/doc.md',
      type: 'document',
      content: 'contenu',
      createdAt: new Date().toISOString(),
      sourceEngine: 'claude-code',
    });
  });

  it('moves every thread/message/memory/artifact from source to target and removes the source project', () => {
    db.mergeProjects('proj-source', 'proj-target');

    expect(db.getProject('proj-source')).toBeUndefined();
    expect(db.getThread('thread-source')?.projectId).toBe('proj-target');
    expect(db.getMessagesForThread('thread-source')[0].projectId).toBe('proj-target');
    expect(db.getMemoriesForProject('proj-target').map((m) => m.id)).toContain('mem-source');
    expect(db.getArtifactsForProject('proj-target').map((a) => a.id)).toContain('art-source');
  });

  it('merges source aliases (and its own real canonicalPath) into the target, so future ingestion resolves straight to the target', () => {
    db.mergeProjects('proj-source', 'proj-target');

    const target = db.getProject('proj-target')!;
    expect(target.aliases.claudeSlugs).toEqual(['slug-a']);
    expect(target.aliases.codexCwds).toEqual(['cwd-b']);
    expect(target.aliases.paths).toContain('/tmp/source');
  });

  it('folds a merged ChatGPT-Project source id into the target\'s chatgptProjectIds alias', () => {
    db.upsertProject(makeProject({ id: 'chatgpt-project-g-p-abc123', name: 'g-p-abc123', canonicalPath: 'chatgpt-project://g-p-abc123' }));
    db.mergeProjects('chatgpt-project-g-p-abc123', 'proj-target');
    expect(db.getProject('proj-target')?.aliases.chatgptProjectIds).toEqual(['g-p-abc123']);
  });

  it('throws for an unknown source or target instead of silently doing nothing', () => {
    expect(() => db.mergeProjects('does-not-exist', 'proj-target')).toThrow();
    expect(() => db.mergeProjects('proj-source', 'does-not-exist')).toThrow();
  });

  it('throws when merging a project into itself', () => {
    expect(() => db.mergeProjects('proj-source', 'proj-source')).toThrow();
  });
});

describe('Db messages — anti-duplicate hash gate', () => {
  beforeEach(() => {
    db.upsertProject(makeProject());
    db.upsertThread({
      id: 'thread-1',
      projectId: 'proj-test',
      title: 'Fil de test',
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
  });

  it('inserts a new message and returns true', () => {
    expect(db.insertMessage(makeMessage())).toBe(true);
    expect(db.getMessagesForThread('thread-1')).toHaveLength(1);
  });

  it('rejects a second message with the same hash and returns false', () => {
    expect(db.insertMessage(makeMessage({ id: 'msg-1' }))).toBe(true);
    expect(db.insertMessage(makeMessage({ id: 'msg-2' }))).toBe(false);
    expect(db.getMessagesForThread('thread-1')).toHaveLength(1);
  });

  it('accepts messages with different hashes', () => {
    expect(db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-1', sequence: 0 }))).toBe(true);
    expect(db.insertMessage(makeMessage({ id: 'msg-2', hash: 'hash-2', sequence: 1 }))).toBe(true);
    expect(db.getMessagesForThread('thread-1')).toHaveLength(2);
  });

  it('self-heals a same-id/different-hash re-ingest by updating in place, instead of crashing', () => {
    // Regression test for a real incident: the message id is stable (derived from the source
    // event), but the hash is derived from parsed content/thought — when adapter parsing logic
    // evolves (e.g. the reasoning-merge changes), re-ingesting the same source file produces the
    // same id with a different hash, which used to crash the whole daemon with an unhandled
    // "UNIQUE constraint failed: messages.id" on every restart.
    expect(db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-1', sequence: 0, content: 'avant' }))).toBe(true);
    expect(db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-2', sequence: 0, content: 'après (fusionné)' }))).toBe(true);
    const messages = db.getMessagesForThread('thread-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('après (fusionné)');
    expect(messages[0].hash).toBe('hash-2');
  });

  it('backfills model/usage onto an already-ingested, unchanged message on hash conflict, without touching an already-set value — regression: SQLite reports the hash UNIQUE violation before the id PRIMARY KEY violation, so the id-conflict "update in place" branch never runs for an otherwise-unchanged rescan', () => {
    expect(db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-1' }))).toBe(true);
    expect(db.getMessagesForThread('thread-1')[0].model).toBeUndefined();

    // Re-ingest of the exact same content, now carrying model/usage an adapter update newly extracts.
    expect(
      db.insertMessage(
        makeMessage({ id: 'msg-1', hash: 'hash-1', model: 'claude-sonnet-5', usage: { inputTokens: 10, outputTokens: 5 } }),
      ),
    ).toBe(false);
    const backfilled = db.getMessagesForThread('thread-1')[0];
    expect(backfilled.model).toBe('claude-sonnet-5');
    expect(backfilled.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // A further hash-conflicting insert with a *different* model must not overwrite the one already recorded.
    expect(
      db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-1', model: 'claude-fable-5', usage: { inputTokens: 99, outputTokens: 99 } })),
    ).toBe(false);
    const unchanged = db.getMessagesForThread('thread-1')[0];
    expect(unchanged.model).toBe('claude-sonnet-5');
    expect(unchanged.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('getProjectTimeline returns verbatim content ordered by timestamp, filterable by since', () => {
    db.insertMessage(makeMessage({ id: 'msg-1', hash: 'hash-1', sequence: 0, timestamp: '2026-01-01T00:00:00Z', content: 'premier' }));
    db.insertMessage(makeMessage({ id: 'msg-2', hash: 'hash-2', sequence: 1, timestamp: '2026-01-02T00:00:00Z', content: 'second' }));

    const all = db.getProjectTimeline('proj-test');
    expect(all.map((m) => m.content)).toEqual(['premier', 'second']);

    const since = db.getProjectTimeline('proj-test', '2026-01-01T12:00:00Z');
    expect(since.map((m) => m.content)).toEqual(['second']);
  });
});

describe('Db thread links', () => {
  beforeEach(() => {
    db.upsertProject(makeProject());
    for (const threadId of ['thread-a', 'thread-b', 'thread-c', 'thread-solo']) {
      db.upsertThread({
        id: threadId,
        projectId: 'proj-test',
        title: `Fil ${threadId}`,
        originEngine: 'claude-code',
        engineIds: {},
        messageCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
      });
    }
  });

  it('links two threads and reports the group from either side', () => {
    const linkId = db.linkThreads(['thread-a', 'thread-b']);
    expect(db.getThreadLink('thread-a')).toEqual({ linkId, threadIds: expect.arrayContaining(['thread-a', 'thread-b']) });
    expect(db.getThreadLink('thread-b')?.threadIds).toHaveLength(2);
  });

  it('growing a link: linking a third thread to an already-linked pair puts all three in one group', () => {
    db.linkThreads(['thread-a', 'thread-b']);
    db.linkThreads(['thread-b', 'thread-c']);
    const link = db.getThreadLink('thread-a')!;
    expect(link.threadIds.sort()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(db.getThreadLink('thread-c')?.linkId).toBe(link.linkId);
  });

  it('an unlinked thread has no link', () => {
    expect(db.getThreadLink('thread-solo')).toBeUndefined();
  });

  it('unlinkThread removes just that thread, leaving the rest of the group intact', () => {
    db.linkThreads(['thread-a', 'thread-b', 'thread-c']);
    db.unlinkThread('thread-a');
    expect(db.getThreadLink('thread-a')).toBeUndefined();
    expect(db.getThreadLink('thread-b')?.threadIds.sort()).toEqual(['thread-b', 'thread-c']);
  });

  it('unlinkThread dissolves the whole group once fewer than two members remain', () => {
    db.linkThreads(['thread-a', 'thread-b']);
    db.unlinkThread('thread-a');
    expect(db.getThreadLink('thread-b')).toBeUndefined();
  });

  it('unlinkThread on a never-linked thread is a no-op', () => {
    expect(() => db.unlinkThread('thread-solo')).not.toThrow();
  });

  it('rejects fewer than two thread ids', () => {
    expect(() => db.linkThreads(['thread-a'])).toThrow();
  });

  it('rejects an unknown thread id', () => {
    expect(() => db.linkThreads(['thread-a', 'does-not-exist'])).toThrow();
  });

  it('getThreadLinkDelta returns only messages from OTHER threads in the group, oldest first', () => {
    db.linkThreads(['thread-a', 'thread-b']);
    db.insertMessage(makeMessage({ id: 'm-a1', threadId: 'thread-a', hash: 'h-a1', timestamp: '2026-01-01T00:00:00Z', content: 'depuis A' }));
    db.insertMessage(makeMessage({ id: 'm-b1', threadId: 'thread-b', hash: 'h-b1', timestamp: '2026-01-02T00:00:00Z', content: 'depuis B' }));

    const delta = db.getThreadLinkDelta('thread-a');
    expect(delta.map((m) => m.content)).toEqual(['depuis B']); // never its own messages
  });

  it('getThreadLinkDelta only returns what is new since the last call for that thread — never replays the whole history', () => {
    db.linkThreads(['thread-a', 'thread-b']);
    db.insertMessage(makeMessage({ id: 'm-b1', threadId: 'thread-b', hash: 'h-b1', timestamp: '2026-01-01T00:00:00Z', content: 'premier' }));

    expect(db.getThreadLinkDelta('thread-a').map((m) => m.content)).toEqual(['premier']);
    expect(db.getThreadLinkDelta('thread-a')).toEqual([]); // already consumed, nothing new

    db.insertMessage(makeMessage({ id: 'm-b2', threadId: 'thread-b', hash: 'h-b2', timestamp: '2026-01-02T00:00:00Z', content: 'second' }));
    expect(db.getThreadLinkDelta('thread-a').map((m) => m.content)).toEqual(['second']); // only the delta

    // The other side's watermark is independent — thread-b still hasn't consumed thread-a's messages.
    db.insertMessage(makeMessage({ id: 'm-a1', threadId: 'thread-a', hash: 'h-a1', timestamp: '2026-01-03T00:00:00Z', content: 'de A' }));
    expect(db.getThreadLinkDelta('thread-b').map((m) => m.content)).toEqual(['de A']);
  });

  it('getThreadLinkDelta returns an empty array for an unlinked thread', () => {
    expect(db.getThreadLinkDelta('thread-solo')).toEqual([]);
  });

  it('when the calling thread itself spoke last in the group, the next check returns nothing — its own new activity is never mistaken for "news from elsewhere"', () => {
    db.linkThreads(['thread-a', 'thread-b']);
    db.insertMessage(makeMessage({ id: 'm-b1', threadId: 'thread-b', hash: 'h-b1', timestamp: '2026-01-01T00:00:00Z', content: 'depuis B' }));
    expect(db.getThreadLinkDelta('thread-a').map((m) => m.content)).toEqual(['depuis B']); // consumes it, watermark advances

    // thread-a keeps talking on its own — several new messages, all on thread-a, none on thread-b.
    db.insertMessage(makeMessage({ id: 'm-a1', threadId: 'thread-a', hash: 'h-a1', timestamp: '2026-01-02T00:00:00Z', content: 'A continue' }));
    db.insertMessage(makeMessage({ id: 'm-a2', threadId: 'thread-a', hash: 'h-a2', timestamp: '2026-01-03T00:00:00Z', content: 'A encore' }));

    // thread-a is now the last to have spoken in the group as a whole — nothing new from anyone else.
    expect(db.getThreadLinkDelta('thread-a')).toEqual([]);
  });
});

describe('Db.searchTranscripts', () => {
  beforeEach(() => {
    db.upsertProject(makeProject());
    db.upsertThread({
      id: 'thread-1',
      projectId: 'proj-test',
      title: 'Fil de test',
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
  });

  it('matches every word regardless of order, not just the exact contiguous phrase — regression for a real find', () => {
    // Real shape: the actual text says "...notre process...nos mises à jour...Ekonum...", scattered
    // and non-contiguous — an exact-phrase search for "mise à jour Ekonum" used to find nothing.
    db.insertMessage(
      makeMessage({
        id: 'm1',
        hash: 'h1',
        content: "Notre process n'est pas assez bon, on rate des choses. On a un souci sur les mises à jour Ekonum.",
      }),
    );
    expect(db.searchTranscripts('mise à jour Ekonum').map((m) => m.id)).toEqual(['m1']);
    expect(db.searchTranscripts('Ekonum mise').map((m) => m.id)).toEqual(['m1']); // word order doesn't matter
  });

  it('a title match still surfaces even when common-word content matches alone would already fill the result limit — regression for a real find: searching the exact real title "Processus mise à jour Ekonum" returned 50 coincidental content hits (all sharing only the near-universal "à") and never reached the title fallback', () => {
    db.upsertThread({
      id: 'thread-title-match',
      projectId: 'proj-test',
      title: 'Processus mise à jour Ekonum',
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    db.insertMessage(
      makeMessage({ id: 'm-title-thread', hash: 'h-title-thread', threadId: 'thread-title-match', role: 'user', content: 'Bonjour' }),
    );
    // Flood the store with a low limit's worth of unrelated messages that each merely contain "à"
    // plus the other query words scattered with no real relation to the target conversation.
    for (let i = 0; i < 5; i++) {
      db.insertMessage(
        makeMessage({
          id: `noise-${i}`,
          hash: `noise-${i}`,
          content: `Un message sans rapport, mais qui mentionne quand même à un endroit un mot comme processus, mise, jour, ou Ekonum : bruit numéro ${i}.`,
        }),
      );
    }

    const results = db.searchTranscripts('Processus mise à jour Ekonum', 5);
    expect(results.map((m) => m.id)).toContain('m-title-thread');
  });

  it('still requires every word to be present — not an OR match', () => {
    db.insertMessage(makeMessage({ id: 'm1', hash: 'h1', content: 'Question sur Ekonum uniquement.' }));
    expect(db.searchTranscripts('Ekonum mot-absent-du-tout')).toEqual([]);
  });

  it('falls back to the thread title when no message content matches, surfacing one representative message', () => {
    db.upsertThread({
      id: 'thread-2',
      projectId: 'proj-test',
      title: 'Processus de mise à jour Ekonum',
      originEngine: 'codex',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });
    db.insertMessage(makeMessage({ id: 'm1', hash: 'h1', threadId: 'thread-2', role: 'user', content: 'Bonjour' }));
    db.insertMessage(makeMessage({ id: 'm2', hash: 'h2', threadId: 'thread-2', role: 'assistant', content: 'Salut' }));

    const results = db.searchTranscripts('Processus Ekonum');
    expect(results.map((m) => m.id)).toEqual(['m1']); // the first user message stands in for the thread
  });

  it('does not duplicate a thread already found via content match when its title also matches', () => {
    db.insertMessage(makeMessage({ id: 'm1', hash: 'h1', content: 'Ekonum processus verbatim ici' }));
    const results = db.searchTranscripts('Ekonum processus');
    expect(results.map((m) => m.id)).toEqual(['m1']);
  });

  it('returns an empty array for an empty or whitespace-only query', () => {
    expect(db.searchTranscripts('')).toEqual([]);
    expect(db.searchTranscripts('   ')).toEqual([]);
  });
});

describe('Db MCP call log', () => {
  it('records a call with its verbatim params and returns it newest-first', () => {
    db.logMcpCall('get_thread', { threadId: 't1' }, false, 'Fil : Test', '2026-01-01T00:00:00Z');
    db.logMcpCall('search_transcripts', { query: 'CVR' }, false, '3 résultats', '2026-01-01T00:01:00Z');

    const calls = db.getRecentMcpCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool: 'search_transcripts', params: { query: 'CVR' }, isError: false, summary: '3 résultats' });
    expect(calls[1].tool).toBe('get_thread');
  });

  it('records an error outcome distinctly', () => {
    db.logMcpCall('get_thread', { threadId: 'does-not-exist' }, true, 'Aucun fil avec cet id.', '2026-01-01T00:00:00Z');
    expect(db.getRecentMcpCalls()[0].isError).toBe(true);
  });

  it('filters by tool name', () => {
    db.logMcpCall('get_thread', { threadId: 't1' }, false, undefined, '2026-01-01T00:00:00Z');
    db.logMcpCall('link_threads', { threadIds: ['t1', 't2'] }, false, undefined, '2026-01-01T00:01:00Z');

    const calls = db.getRecentMcpCalls(100, 'link_threads');
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('link_threads');
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) db.logMcpCall('search_transcripts', { query: `q${i}` }, false, undefined, `2026-01-01T00:0${i}:00Z`);
    expect(db.getRecentMcpCalls(2)).toHaveLength(2);
  });
});

describe('Db schema migration', () => {
  it('adds columns introduced after a database file was first created, without crashing on real pre-existing data', () => {
    // Regression test for a real incident: hub.sqlite created before `archived`/`source_file_path`
    // existed in the schema crashed the whole daemon on startup with "no column named
    // source_file_path", because CREATE TABLE IF NOT EXISTS never touches an existing table.
    const migDir = mkdtempSync(join(tmpdir(), 'sync-hub-migration-'));
    const filePath = join(migDir, 'hub.sqlite');

    const legacy = new BetterSqlite3(filePath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, origin_engine TEXT NOT NULL,
        engine_ids TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    legacy.prepare('INSERT INTO projects (id, name, canonical_path, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)').run(
      'proj-legacy', 'Legacy', '/tmp/legacy', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
    );
    legacy.close();

    const migrated = new Db(filePath);
    expect(migrated.getProject('proj-legacy')).toMatchObject({ id: 'proj-legacy', archived: false });

    expect(() =>
      migrated.upsertThread({
        id: 't-legacy',
        projectId: 'proj-legacy',
        title: 'Fil existant',
        originEngine: 'claude-code',
        engineIds: {},
        sourceFilePath: '/tmp/legacy/session.jsonl',
        messageCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        status: 'active',
      }),
    ).not.toThrow();

    migrated.close();
    rmSync(migDir, { recursive: true, force: true });
  });
});
