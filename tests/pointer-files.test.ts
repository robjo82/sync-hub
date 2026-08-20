import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { updatePointerFiles } from '../src/core/pointer-files.js';
import type { Message, Project } from '../src/types.js';

let dir: string;
let projectPath: string;
let db: Db;

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-demo',
    name: 'demo',
    canonicalPath: projectPath,
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: 'm1',
    threadId: 't1',
    projectId: 'proj-demo',
    sourceEngine: 'claude-code',
    role: 'user',
    content: 'x',
    timestamp: now,
    sequence: 0,
    hash: 'h1',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-pointer-'));
  projectPath = join(dir, 'demo-project');
  mkdirSync(projectPath, { recursive: true });
  db = new Db(join(dir, 'hub.sqlite'));
  db.upsertProject(project());
  db.upsertThread({
    id: 't1',
    projectId: 'proj-demo',
    title: 'Fil',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('updatePointerFiles', () => {
  it('writes a factual one-line pointer (no content summary) into both CLAUDE.md and AGENTS.md', () => {
    db.insertMessage(message({ sourceEngine: 'claude-code', timestamp: '2026-01-01T11:58:00Z', content: 'contenu réel du message' }));
    const now = new Date('2026-01-01T12:00:00Z');

    updatePointerFiles(db, db.getProject('proj-demo')!, now);

    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readFileSync(join(projectPath, file), 'utf-8');
      expect(text).toContain('sync-hub');
      expect(text).toContain('Claude Code');
      expect(text).toContain('il y a 2 min');
      // The pointer must never embed the actual message content — that's what the MCP query is for.
      expect(text).not.toContain('contenu réel du message');
    }
  });

  it('is idempotent: re-running replaces only the managed block and preserves the rest of an existing file', () => {
    writeFileSync(join(projectPath, 'CLAUDE.md'), '# Notes perso de Robin\n\nCeci ne doit jamais être perdu.\n');
    db.insertMessage(message({ sourceEngine: 'codex', timestamp: '2026-01-01T00:00:00Z' }));

    updatePointerFiles(db, db.getProject('proj-demo')!, new Date('2026-01-01T00:05:00Z'));
    updatePointerFiles(db, db.getProject('proj-demo')!, new Date('2026-01-01T01:00:00Z'));

    const text = readFileSync(join(projectPath, 'CLAUDE.md'), 'utf-8');
    expect(text).toContain('Ceci ne doit jamais être perdu.');
    expect(text.match(/sync-hub:begin/g)).toHaveLength(1); // not duplicated
    expect(text).toContain('il y a 1 h'); // reflects the second run's timestamp, not the first
  });

  it('does nothing for the unassigned project (no canonical path to write into)', () => {
    updatePointerFiles(db, { ...project(), id: 'unassigned', canonicalPath: '' }, new Date());
    // No error thrown, and nothing written outside the temp project dir — nothing to assert on disk.
  });
});
