import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { discoverSessionFiles, ingestSessionFile, parseLine, refFromFilePath } from '../src/core/adapters/antigravity.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'antigravity', 'brain');

describe('parseLine — real Antigravity transcript_full.jsonl schema', () => {
  it('extracts the verbatim user text from inside <USER_REQUEST>, discarding injected <ADDITIONAL_METADATA>', () => {
    const parsed = parseLine(
      JSON.stringify({
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>\nBonjour\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnot typed by the user\n</ADDITIONAL_METADATA>',
      }),
      'sess-1',
    );
    expect(parsed).toMatchObject({ role: 'user', content: 'Bonjour' });
  });

  it('falls back to the raw content if the <USER_REQUEST> tag is ever absent, rather than dropping the line', () => {
    const parsed = parseLine(
      JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: 't', content: 'texte brut sans balise' }),
      'sess-1',
    );
    expect(parsed).toMatchObject({ role: 'user', content: 'texte brut sans balise' });
  });

  it('maps a final PLANNER_RESPONSE (content present) to the assistant reply', () => {
    const parsed = parseLine(
      JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: 't', content: 'Voici la réponse.' }),
      'sess-1',
    );
    expect(parsed).toMatchObject({ role: 'assistant', content: 'Voici la réponse.' });
  });

  it('maps an intermediate PLANNER_RESPONSE (thinking + tool_calls, no content) to a thought/toolCalls-only assistant entry', () => {
    const parsed = parseLine(
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: 't',
        step_index: 5,
        thinking: 'je réfléchis',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }],
      }),
      'sess-1',
    );
    expect(parsed).toMatchObject({ role: 'assistant', content: '', thought: 'je réfléchis' });
    expect(parsed?.toolCalls?.[0]).toMatchObject({ id: 'sess-1-5-0', name: 'run_command', arguments: { CommandLine: 'ls' } });
  });

  it('maps GENERIC to a standalone tool-result message (no id links it back to a specific call in this format)', () => {
    const parsed = parseLine(JSON.stringify({ source: 'MODEL', type: 'GENERIC', created_at: 't', step_index: 6, content: 'Output: ok' }), 'sess-1');
    expect(parsed?.role).toBe('tool');
    expect(parsed?.toolResults?.[0]).toMatchObject({ toolCallId: 'sess-1-6', output: 'Output: ok', status: 'success' });
  });

  it('maps SYSTEM_MESSAGE to a system-role message, verbatim', () => {
    const parsed = parseLine(JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: 't', content: 'Task finished' }), 'sess-1');
    expect(parsed).toMatchObject({ role: 'system', content: 'Task finished' });
  });

  it('skips CHECKPOINT (internal context-truncation bookkeeping, not conversational content)', () => {
    expect(parseLine(JSON.stringify({ source: 'SYSTEM', type: 'CHECKPOINT', content: 'summary' }), 'sess-1')).toBeNull();
  });

  it('skips empty lines and unparseable JSON without throwing', () => {
    expect(parseLine('', 'sess-1')).toBeNull();
    expect(parseLine('not json', 'sess-1')).toBeNull();
  });
});

describe('refFromFilePath', () => {
  it('resolves the session id from a transcript_full.jsonl path', () => {
    const filePath = join(FIXTURE_ROOT, 'fixture-session-0001', '.system_generated', 'logs', 'transcript_full.jsonl');
    expect(refFromFilePath(filePath)).toEqual({ filePath, sessionId: 'fixture-session-0001' });
  });

  it('returns null for any other file, including the sibling transcript.jsonl', () => {
    const filePath = join(FIXTURE_ROOT, 'fixture-session-0001', '.system_generated', 'logs', 'transcript.jsonl');
    expect(refFromFilePath(filePath)).toBeNull();
  });
});

describe('discoverSessionFiles', () => {
  it('finds only session dirs that actually have a transcript_full.jsonl, ignoring ones that don\'t', () => {
    const refs = discoverSessionFiles(FIXTURE_ROOT);
    expect(refs).toHaveLength(1);
    expect(refs[0].sessionId).toBe('fixture-session-0001');
  });
});

describe('ingestSessionFile — end to end against a real-shaped Antigravity fixture', () => {
  let dir: string;
  let db: Db;
  let registry: ProjectRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-antigravity-adapter-'));
    db = new Db(join(dir, 'hub.sqlite'));
    registry = new ProjectRegistry(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tails an appended transcript without losing accented lines to a byte/character mismatch', () => {
    // The regression this pins, seen on the real corpus: the watcher records a byte size and hands
    // it back as the offset, but the adapter used to slice a decoded string with it. One accented
    // character is two bytes and one string index, so the tail started too far into the file and
    // whole turns vanished — silently, since a short read is indistinguishable from "nothing new".
    const sessionDir = join(dir, 'brain', 'sess-tail', '.system_generated', 'logs');
    mkdirSync(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'transcript_full.jsonl');

    const first =
      JSON.stringify({
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-01-01T00:00:00Z',
        content: '<USER_REQUEST>Première question très accentuée : éàüœ, déjà mesuré</USER_REQUEST>',
      }) + '\n';
    writeFileSync(filePath, first);

    const ref = refFromFilePath(filePath)!;
    expect(ref).not.toBeNull();
    expect(ingestSessionFile(db, registry, ref)).toBe(1);

    const offset = statSync(filePath).size;
    expect(offset).toBeGreaterThan(first.length); // bytes exceed characters — the trap

    const second =
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-01-01T00:01:00Z',
        content: 'La réponse qui suit, elle aussi accentuée.',
      }) + '\n';
    appendFileSync(filePath, second);

    expect(ingestSessionFile(db, registry, ref, { fromOffset: offset })).toBe(1);

    const contents = db.getMessagesForThread('sess-tail').map((m) => m.content);
    expect(contents).toEqual([
      'Première question très accentuée : éàüœ, déjà mesuré',
      'La réponse qui suit, elle aussi accentuée.',
    ]);
  });

  it('ingests every real event in order, lands in "unassigned" (no reliable path signal to resolve against — never guessed), derives a title from the first user message, and dedupes on re-ingestion', () => {
    const refs = discoverSessionFiles(FIXTURE_ROOT);
    expect(refs).toHaveLength(1);

    const inserted = ingestSessionFile(db, registry, refs[0]);
    // user, assistant(thought+toolCalls), tool(result), system, assistant(reply), user, assistant(thought+toolCalls, mid-turn) = 7.
    // The CHECKPOINT line is skipped, not counted.
    expect(inserted).toBe(7);

    const thread = db.getThread('fixture-session-0001');
    expect(thread?.projectId).toBe(UNASSIGNED_PROJECT_ID);
    expect(thread?.originEngine).toBe('antigravity');
    expect(thread?.title).toBe('Peux-tu lister les fichiers du dossier demo ?');

    const messages = db.getMessagesForThread('fixture-session-0001');
    expect(messages).toHaveLength(7);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Peux-tu lister les fichiers du dossier demo ?' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '', thought: 'Je vais lister le dossier avec un outil.' });
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: 'run_command' });
    expect(messages[2].toolResults?.[0]).toMatchObject({ output: 'Created At: 2026-01-01T10:00:03Z\nOutput:\nfichier_a.txt\nfichier_b.txt' });
    expect(messages[3]).toMatchObject({ role: 'system' });
    expect(messages[4]).toMatchObject({ role: 'assistant', content: 'Le dossier contient fichier_a.txt et fichier_b.txt.' });
    expect(messages[5]).toMatchObject({ role: 'user', content: 'Et le dossier suivant ?' });
    // The still-open turn (no final PLANNER_RESPONSE with content yet) is preserved as its own
    // message rather than dropped — real shape of one of Robin's two open sessions at write time.
    expect(messages[6]).toMatchObject({ role: 'assistant', content: '', thought: 'Je regarde le dossier suivant.' });
    expect(messages[6].toolCalls?.[0]).toMatchObject({ name: 'run_command' });

    const secondPass = ingestSessionFile(db, registry, refs[0]);
    expect(secondPass).toBe(0);
  });

  it('a thread with no real source file (Antigravity engine) is still reassignable to a real project via manual triage', () => {
    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: '/Users/robin/Projets/demo',
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: now,
      lastActiveAt: now,
    });
    ingestSessionFile(db, registry, discoverSessionFiles(FIXTURE_ROOT)[0]);
    db.reassignThread('fixture-session-0001', 'proj-demo');
    expect(db.getThread('fixture-session-0001')?.projectId).toBe('proj-demo');
  });
});
