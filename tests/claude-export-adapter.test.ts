import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { ingestClaudeExport } from '../src/core/adapters/claude-export.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'claude-export');

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-claude-export-'));
  db = new Db(join(dir, 'hub.sqlite'));
  new ProjectRegistry(db); // ensures the "unassigned" sentinel project row exists, as it always does in real usage
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestClaudeExport', () => {
  it('imports verbatim messages, correctly combining text/thinking/tool_use/tool_result per turn and skipping token_budget', () => {
    const inserted = ingestClaudeExport(db, FIXTURE_DIR);
    expect(inserted).toBe(4);

    const thread = db.getThread('claude-export-fixture-conv-0001');
    expect(thread?.title).toContain('Question factice sur les migrations Odoo');
    expect(thread?.title).toContain('importé');
    // Web exports carry no cwd/project signal — always lands unassigned for manual triage, same as any ambiguous source.
    expect(thread?.projectId).toBe(UNASSIGNED_PROJECT_ID);

    const messages = db.getMessagesForThread('claude-export-fixture-conv-0001');
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Comment migrer un module Odoo de la v18 à la v19 ?' });
    expect(messages[1]).toMatchObject({ role: 'assistant', thought: 'Je vais chercher les changements de version.' });
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: 'web_search' });
    expect(messages[2].toolResults?.[0]).toMatchObject({ toolCallId: 'toolu_fixture_1', output: 'Résultat de recherche factice' });
    expect(messages[3]).toMatchObject({ role: 'assistant', content: 'Voici les étapes principales pour migrer.' });

    // Every imported message is tagged as such — never indistinguishable from a live-synced one.
    for (const m of messages) expect(m.metadata).toMatchObject({ imported: true, source: 'claude-export' });
  });

  it('is idempotent across repeated imports of the same export file', () => {
    ingestClaudeExport(db, FIXTURE_DIR);
    const second = ingestClaudeExport(db, FIXTURE_DIR);
    expect(second).toBe(0);
    expect(db.getMessagesForThread('claude-export-fixture-conv-0001')).toHaveLength(4);
  });

  it('returns 0 without error when conversations.json is absent', () => {
    expect(ingestClaudeExport(db, dir)).toBe(0);
  });

  it('a manual project assignment survives a later re-scan instead of being reset to unassigned — regression for a real bug found this session', () => {
    ingestClaudeExport(db, FIXTURE_DIR);
    const threadId = 'claude-export-fixture-conv-0001';
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: '/tmp/demo',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    db.reassignThread(threadId, 'proj-demo');

    ingestClaudeExport(db, FIXTURE_DIR);

    expect(db.getThread(threadId)?.projectId).toBe('proj-demo');
  });
});
