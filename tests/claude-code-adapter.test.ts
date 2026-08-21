import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry, pathToClaudeSlug } from '../src/core/registry.js';
import { discoverSessionFiles, ingestSessionFile, parseLine } from '../src/core/adapters/claude-code.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'claude-code');
const PROJECT_PATH = '/Users/robin/Projets/demo';

describe('parseLine — real Claude Code JSONL schema', () => {
  it('skips non-conversational event types', () => {
    expect(parseLine('{"type":"attachment","attachment":{}}')).toBeNull();
    expect(parseLine('{"type":"system","content":"x"}')).toBeNull();
    expect(parseLine('{"type":"queue-operation"}')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('parses a plain-string user message', () => {
    const parsed = parseLine(
      '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Bonjour"}}',
    );
    expect(parsed).toMatchObject({ role: 'user', content: 'Bonjour' });
  });

  it('extracts thinking + tool_use from an assistant message', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'je réfléchis' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    );
    expect(parsed?.role).toBe('assistant');
    expect(parsed?.thought).toBe('je réfléchis');
    expect(parsed?.toolCalls).toEqual([{ id: 'tool-1', name: 'Bash', arguments: { command: 'ls' } }]);
  });

  it('classifies a user-type tool_result block as role "tool"', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'user',
        uuid: 'r1',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sortie', is_error: false }],
        },
      }),
    );
    expect(parsed?.role).toBe('tool');
    expect(parsed?.toolResults).toEqual([{ toolCallId: 'tool-1', name: 'tool-1', output: 'sortie', status: 'success' }]);
  });

  it('extracts model + usage from a real assistant event, splitting 5m/1h cache writes as reported', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          model: 'claude-fable-5',
          content: [{ type: 'text', text: 'bonjour' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 },
          },
        },
      }),
    );
    expect(parsed?.model).toBe('claude-fable-5');
    expect(parsed?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation5mInputTokens: 5,
      cacheCreation1hInputTokens: 15,
      cacheReadInputTokens: 20,
    });
  });

  it('drops <synthetic> events entirely — never billed, so never kept as a priced model id', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'bonjour' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    );
    expect(parsed?.model).toBeUndefined();
    expect(parsed?.usage).toBeUndefined();
  });
});

describe('ingestSessionFile — end to end against a real-shaped fixture', () => {
  let dir: string;
  let db: Db;
  let registry: ProjectRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-claude-adapter-'));
    db = new Db(join(dir, 'hub.sqlite'));
    registry = new ProjectRegistry(db);
    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: PROJECT_PATH,
      aliases: { paths: [PROJECT_PATH], claudeSlugs: [pathToClaudeSlug(PROJECT_PATH)], codexCwds: [PROJECT_PATH] },
      createdAt: now,
      lastActiveAt: now,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the project via the real Claude Code slug and ingests verbatim, deduped messages', () => {
    const refs = discoverSessionFiles(FIXTURE_ROOT);
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe('-Users-robin-Projets-demo');

    const inserted = ingestSessionFile(db, registry, refs[0]);
    // 5 conversational lines in the fixture, but evt-1-dup has the same hash as evt-1 → deduped.
    expect(inserted).toBe(4);

    const thread = db.getThread('session-fixture-0001');
    expect(thread?.projectId).toBe('proj-demo');
    expect(thread?.title).toBe('Peux-tu lister les fichiers du dossier ?');

    const messages = db.getMessagesForThread('session-fixture-0001');
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Peux-tu lister les fichiers du dossier ?' });
    expect(messages[1]).toMatchObject({ role: 'assistant', thought: 'Je vais lister le dossier avec un outil.' });
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: 'Bash' });
    expect(messages[2]).toMatchObject({ role: 'tool' });
    expect(messages[2].toolResults?.[0].output).toContain('fichier_a.txt');
    expect(messages[3]).toMatchObject({ role: 'assistant', content: 'Le dossier contient fichier_a.txt et fichier_b.txt.' });

    // Re-ingesting the same file must not create duplicates (idempotent full scan).
    const secondPass = ingestSessionFile(db, registry, refs[0]);
    expect(secondPass).toBe(0);
    expect(db.getMessagesForThread('session-fixture-0001')).toHaveLength(4);
  });

  it('prefers the real custom-title over the auto-derived one, even though custom-title carries no conversational content — regression: a user-set title ("Processus mise à jour Ekonum") was discarded in favor of a mangled prefix of the first prompt', () => {
    const slugDir = join(dir, 'claude-root', pathToClaudeSlug(PROJECT_PATH));
    mkdirSync(slugDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Un très long premier message qui ne dit rien du sujet réel de la conversation, juste du contexte en vrac.' } },
      { type: 'ai-title', aiTitle: 'Titre suggéré par le modèle', sessionId: 'title-session' },
      { type: 'custom-title', customTitle: 'Processus mise à jour Ekonum', sessionId: 'title-session' },
    ];
    writeFileSync(join(slugDir, 'title-session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, { filePath: join(slugDir, 'title-session.jsonl'), slug: pathToClaudeSlug(PROJECT_PATH), sessionId: 'title-session' });
    expect(db.getThread('title-session')?.title).toBe('Processus mise à jour Ekonum');
  });

  it('falls back to the ai-suggested title when there is no custom-title', () => {
    const slugDir = join(dir, 'claude-root', pathToClaudeSlug(PROJECT_PATH));
    mkdirSync(slugDir, { recursive: true });
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Bonjour' } },
      { type: 'ai-title', aiTitle: 'Titre suggéré par le modèle', sessionId: 'ai-title-session' },
    ];
    writeFileSync(join(slugDir, 'ai-title-session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, {
      filePath: join(slugDir, 'ai-title-session.jsonl'),
      slug: pathToClaudeSlug(PROJECT_PATH),
      sessionId: 'ai-title-session',
    });
    expect(db.getThread('ai-title-session')?.title).toBe('Titre suggéré par le modèle');
  });

  it('picks up a real title on a later rescan even though the thread was already ingested without one', () => {
    const slugDir = join(dir, 'claude-root', pathToClaudeSlug(PROJECT_PATH));
    mkdirSync(slugDir, { recursive: true });
    const filePath = join(slugDir, 'renamed-session.jsonl');
    const ref = { filePath, slug: pathToClaudeSlug(PROJECT_PATH), sessionId: 'renamed-session' };

    writeFileSync(filePath, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Bonjour' } }) + '\n');
    ingestSessionFile(db, registry, ref);
    expect(db.getThread('renamed-session')?.title).toBe('Bonjour');

    // The user renames the conversation later — Claude Code appends a custom-title event.
    writeFileSync(
      filePath,
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Bonjour' } }) +
        '\n' +
        JSON.stringify({ type: 'custom-title', customTitle: 'Nom choisi après coup', sessionId: 'renamed-session' }) +
        '\n',
    );
    ingestSessionFile(db, registry, ref);
    expect(db.getThread('renamed-session')?.title).toBe('Nom choisi après coup');
  });

  it('routes an unregistered project slug to the unassigned bucket, never guessing', () => {
    const refs = discoverSessionFiles(FIXTURE_ROOT);
    db.raw.prepare('DELETE FROM projects WHERE id = ?').run('proj-demo');
    const registryWithoutProject = new ProjectRegistry(db);
    ingestSessionFile(db, registryWithoutProject, refs[0]);
    expect(db.getThread('session-fixture-0001')?.projectId).toBe(UNASSIGNED_PROJECT_ID);
  });
});
