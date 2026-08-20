import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { ingestChatGptExport } from '../src/core/adapters/chatgpt-export.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'chatgpt-export');

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-chatgpt-export-'));
  db = new Db(join(dir, 'hub.sqlite'));
  new ProjectRegistry(db); // ensures the "unassigned" sentinel project row exists, as it always does in real usage
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestChatGptExport', () => {
  it('walks the real (parent-linked, no children field) tree from current_node, folds thoughts into the following reply, excludes abandoned branches', () => {
    const inserted = ingestChatGptExport(db, FIXTURE_DIR);
    // user1 + [thoughts1 folded into assistant1] = 2. recap1 is walked but skipped (UI timer label). "abandoned" is never reached.
    expect(inserted).toBe(2);

    const thread = db.getThread('chatgpt-export-fixture-conv-0001');
    expect(thread?.projectId).toBe(UNASSIGNED_PROJECT_ID); // no cwd/project signal in a web export — always triage
    expect(thread?.title).toContain('Question factice sur les migrations Odoo');

    const messages = db.getMessagesForThread('chatgpt-export-fixture-conv-0001');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Comment migrer un module Odoo de la v18 à la v19 ?' });
    // The reasoning that led to this reply is folded in as `thought`, not counted as its own message.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Voici les étapes principales pour migrer.',
      thought: 'Je réfléchis à la meilleure façon de migrer.',
    });

    // The abandoned sibling branch must never appear anywhere.
    expect(messages.some((m) => m.content.includes('abandonnée'))).toBe(false);

    for (const m of messages) expect(m.metadata).toMatchObject({ imported: true, source: 'chatgpt-export' });
  });

  it('uses the real update_time for sorting, not create_time — a conversation revisited long after it started must not look stale', () => {
    const dirWithUpdate = mkdtempSync(join(tmpdir(), 'sync-hub-chatgpt-update-time-'));
    writeFileSync(
      join(dirWithUpdate, 'conversations-000.json'),
      JSON.stringify([
        {
          id: 'conv-old-start-recent-activity',
          title: 'Reprise tardive',
          create_time: 1000,
          update_time: 999999,
          current_node: 'u1',
          mapping: {
            u1: { id: 'u1', parent: null, message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['x'] }, create_time: 1000 } },
          },
        },
      ]),
    );
    ingestChatGptExport(db, dirWithUpdate);
    const thread = db.getThread('chatgpt-export-conv-old-start-recent-activity');
    expect(thread?.createdAt).toBe(new Date(1000 * 1000).toISOString());
    expect(thread?.updatedAt).toBe(new Date(999999 * 1000).toISOString());
    rmSync(dirWithUpdate, { recursive: true, force: true });
  });

  it('is idempotent across repeated imports', () => {
    ingestChatGptExport(db, FIXTURE_DIR);
    const second = ingestChatGptExport(db, FIXTURE_DIR);
    expect(second).toBe(0);
  });

  it('returns 0 without error when there are no conversations-NNN.json shards', () => {
    expect(ingestChatGptExport(db, dir)).toBe(0);
  });

  it('skips an empty `{}` conversation stub without crashing — found once in a real 5164-conversation export', () => {
    const dirWithStub = mkdtempSync(join(tmpdir(), 'sync-hub-chatgpt-stub-'));
    writeFileSync(join(dirWithStub, 'conversations-000.json'), JSON.stringify([{}, { id: 'real-one', mapping: {} }]));
    expect(() => ingestChatGptExport(db, dirWithStub)).not.toThrow();
    rmSync(dirWithStub, { recursive: true, force: true });
  });

  it('a manual project assignment survives a later re-scan instead of being reset to unassigned — regression for a real bug found this session', () => {
    ingestChatGptExport(db, FIXTURE_DIR);
    const threadId = 'chatgpt-export-fixture-conv-0001';
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: '/tmp/demo',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    db.reassignThread(threadId, 'proj-demo'); // simulates the dashboard's "assign" action

    ingestChatGptExport(db, FIXTURE_DIR); // a later rescan (e.g. server restart) must not undo it

    expect(db.getThread(threadId)?.projectId).toBe('proj-demo');
  });

  it('creates a real sync-hub project for a known ChatGPT Project — not just a title prefix — and assigns the thread + its messages to it', () => {
    const projectFixtureDir = join(import.meta.dirname, 'fixtures', 'chatgpt-export-with-project');
    const cacheRoot = join(import.meta.dirname, 'fixtures', 'chatgpt-projects-cache');

    ingestChatGptExport(db, projectFixtureDir, cacheRoot);

    const project = db.getProject('chatgpt-project-g-p-fixturetest0001');
    expect(project?.name).toBe('C00999 - Client Factice');
    expect(project?.canonicalPath).not.toBe(''); // distinct synthetic path — never collides with the unassigned sentinel's ''

    const known = db.getThread('chatgpt-export-fixture-conv-project-0001');
    expect(known?.projectId).toBe('chatgpt-project-g-p-fixturetest0001');
    expect(known?.title).not.toContain('C00999'); // no longer needed in the title — the grouping itself carries it now
    expect(known?.sourceRef).toBe('g-p-fixturetest0001');
    // Messages must live in the same project as their thread, or search/timeline queries scoped to the project would miss them.
    expect(db.getMessagesForThread(known!.id)[0].projectId).toBe('chatgpt-project-g-p-fixturetest0001');

    // No cached name — falls back to the first real conversation title seen for it (a real,
    // verbatim label) rather than the opaque raw id, still grouped for real either way.
    const unknownProject = db.getProject('chatgpt-project-g-p-unknownproject9999');
    expect(unknownProject?.name).toBe('Question sans projet connu');
    const unknown = db.getThread('chatgpt-export-fixture-conv-unknown-project-0002');
    expect(unknown?.projectId).toBe('chatgpt-project-g-p-unknownproject9999');
  });

  it('respects a manual merge of a ChatGPT Project into a different real project across re-scans, instead of recreating the deterministic id', () => {
    const projectFixtureDir = join(import.meta.dirname, 'fixtures', 'chatgpt-export-with-project');
    const cacheRoot = join(import.meta.dirname, 'fixtures', 'chatgpt-projects-cache');
    ingestChatGptExport(db, projectFixtureDir, cacheRoot);

    db.upsertProject({
      id: 'proj-real-client',
      name: 'Vrai projet client',
      canonicalPath: '/tmp/vrai-projet',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    db.mergeProjects('chatgpt-project-g-p-fixturetest0001', 'proj-real-client'); // simulates the dashboard's "Fusionner" action

    ingestChatGptExport(db, projectFixtureDir, cacheRoot); // a later rescan (e.g. server restart) must not undo it

    expect(db.getProject('chatgpt-project-g-p-fixturetest0001')).toBeUndefined();
    expect(db.getThread('chatgpt-export-fixture-conv-project-0001')?.projectId).toBe('proj-real-client');
  });

  it('retroactively groups a thread stuck at the unassigned sentinel from before ChatGPT Project grouping existed — regression for a real bug found this session', () => {
    const projectFixtureDir = join(import.meta.dirname, 'fixtures', 'chatgpt-export-with-project');
    const cacheRoot = join(import.meta.dirname, 'fixtures', 'chatgpt-projects-cache');

    // Simulates a thread ingested by an older build of the adapter that always hardcoded
    // UNASSIGNED_PROJECT_ID, before ChatGPT Project grouping was added — never a deliberate
    // manual triage, just the pre-feature default.
    db.upsertThread({
      id: 'chatgpt-export-fixture-conv-project-0001',
      projectId: 'unassigned',
      title: 'stale title (importé)',
      originEngine: 'codex',
      engineIds: {},
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    });

    ingestChatGptExport(db, projectFixtureDir, cacheRoot);

    expect(db.getThread('chatgpt-export-fixture-conv-project-0001')?.projectId).toBe('chatgpt-project-g-p-fixturetest0001');
  });

  it('a manual re-triage of a ChatGPT-Project-grouped thread to a different real project survives a later re-scan', () => {
    const projectFixtureDir = join(import.meta.dirname, 'fixtures', 'chatgpt-export-with-project');
    const cacheRoot = join(import.meta.dirname, 'fixtures', 'chatgpt-projects-cache');
    ingestChatGptExport(db, projectFixtureDir, cacheRoot);

    db.upsertProject({
      id: 'proj-real',
      name: 'real',
      canonicalPath: '/tmp/real',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    db.reassignThread('chatgpt-export-fixture-conv-project-0001', 'proj-real');

    ingestChatGptExport(db, projectFixtureDir, cacheRoot);

    expect(db.getThread('chatgpt-export-fixture-conv-project-0001')?.projectId).toBe('proj-real');
  });
});
