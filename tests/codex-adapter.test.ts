import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { discoverSessionFiles, ingestSessionFile, parseLine } from '../src/core/adapters/codex.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'codex', 'sessions');
const PROJECT_PATH = '/Users/robin/Projets/demo';

describe('parseLine — real Codex rollout JSONL schema', () => {
  it('skips session_meta, turn_context and non-response_item events', () => {
    expect(parseLine('{"type":"session_meta","payload":{}}')).toBeNull();
    expect(parseLine('{"type":"event_msg","payload":{"type":"task_started"}}')).toBeNull();
    expect(parseLine('{"type":"turn_context","payload":{}}')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('skips developer-role messages (Codex-injected permission boilerplate)', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system stuff' }] },
      }),
    );
    expect(parsed).toBeNull();
  });

  it('extracts a verbatim user message from input_text blocks', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour' }] },
      }),
    );
    expect(parsed).toMatchObject({ role: 'user', content: 'Bonjour' });
  });

  it('extracts an assistant message from output_text blocks', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Réponse' }] },
      }),
    );
    expect(parsed).toMatchObject({ role: 'assistant', content: 'Réponse' });
  });

  it('maps a reasoning item to a thought-only assistant entry (summary text only — full CoT is encrypted server-side)', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'je réfléchis' }], content: null },
      }),
    );
    expect(parsed).toMatchObject({ role: 'assistant', thought: 'je réfléchis', content: '' });
  });

  it('parses function_call / function_call_output as a tool-call/tool-result pair joined by call_id', () => {
    const call = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"ls"}', call_id: 'call-1' },
      }),
    );
    expect(call?.toolCalls).toEqual([{ id: 'call-1', name: 'shell_command', arguments: { command: 'ls' } }]);

    const output = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'a.txt\nb.txt' },
      }),
    );
    expect(output).toMatchObject({ role: 'tool', toolResults: [{ toolCallId: 'call-1', output: 'a.txt\nb.txt', status: 'success' }] });
  });

  it('parses custom_tool_call / custom_tool_call_output (apply_patch style) the same way', () => {
    const call = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch ***', call_id: 'call-2' },
      }),
    );
    expect(call?.toolCalls).toEqual([{ id: 'call-2', name: 'apply_patch', arguments: '*** Begin Patch ***' }]);
  });

  it('skips synthetic system notices injected as role:"user" (verified against real sessions: environment_context, task-notification, recommended_plugins, etc. — not something the human typed)', () => {
    for (const tag of ['recommended_plugins', 'environment_context', 'task-notification']) {
      const parsed = parseLine(
        JSON.stringify({
          type: 'response_item',
          timestamp: 't',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<${tag}>\nboilerplate\n</${tag}>` }] },
        }),
      );
      expect(parsed, `tag: ${tag}`).toBeNull();
    }
  });

  it('does not skip a real user message that merely mentions a tag-like word without the wrapper', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Parle-moi de environment_context stp' }] },
      }),
    );
    expect(parsed).not.toBeNull();
  });

  it('strips the "Applications/Files mentioned by the user" preamble Codex injects ahead of an @-mention, keeping only the text after "## My request:" — regression for a real find (the whole preamble was displayed as if Robin had typed it)', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                '\n# Applications mentioned by the user:\n\n[@Google Drive](plugin://computer-use@openai-bundled?app=com.google.drivefs)\n\n## My request:\nQu\'est-ce que tu sais du projet à date ?',
            },
          ],
        },
      }),
    );
    expect(parsed).toMatchObject({ role: 'user', content: "Qu'est-ce que tu sais du projet à date ?" });
  });

  it('leaves an ordinary message with no injected preamble untouched, even if it happens to contain "My request" as plain text', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: 't',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'My request is simple: fix the bug.' }] },
      }),
    );
    expect(parsed).toMatchObject({ role: 'user', content: 'My request is simple: fix the bug.' });
  });
});

describe('ingestSessionFile — end to end against a real-shaped Codex fixture', () => {
  let dir: string;
  let db: Db;
  let registry: ProjectRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-hub-codex-adapter-'));
    db = new Db(join(dir, 'hub.sqlite'));
    registry = new ProjectRegistry(db);
    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-demo',
      name: 'demo',
      canonicalPath: PROJECT_PATH,
      aliases: { paths: [PROJECT_PATH], claudeSlugs: [], codexCwds: [PROJECT_PATH] },
      createdAt: now,
      lastActiveAt: now,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the project via the real cwd from session_meta, uses the real thread_name, folds reasoning into the following message, and dedupes', () => {
    const refs = discoverSessionFiles([FIXTURE_ROOT]);
    expect(refs).toHaveLength(1);

    const inserted = ingestSessionFile(db, registry, refs[0]);
    // user, [reasoning folded into function_call], function_call_output, custom_tool_call,
    // custom_tool_call_output, assistant message = 6. The trailing duplicate user line is deduped.
    expect(inserted).toBe(6);

    const thread = db.getThread('fixture-session-0002');
    expect(thread?.projectId).toBe('proj-demo');
    expect(thread?.title).toBe('Lister le dossier demo'); // real Codex-assigned thread_name, not derived

    const messages = db.getMessagesForThread('fixture-session-0002');
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Peux-tu lister les fichiers du dossier ?' });
    // The reasoning that led to this tool call is folded in as `thought`, not a separate message.
    expect(messages[1]).toMatchObject({ thought: 'Je vais lister le dossier avec un outil.' });
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: 'shell_command' });
    expect(messages[2].toolResults?.[0]).toMatchObject({ toolCallId: 'call-1', output: 'fichier_a.txt\nfichier_b.txt' });
    expect(messages[3].toolCalls?.[0]).toMatchObject({ name: 'apply_patch' });
    expect(messages[5]).toMatchObject({ role: 'assistant', content: 'Le dossier contient fichier_a.txt et fichier_b.txt.' });

    const secondPass = ingestSessionFile(db, registry, refs[0]);
    expect(secondPass).toBe(0);
  });

  it('folds multiple consecutive reasoning entries into the next assistant message, in order', () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'sync-hub-codex-multi-reason-'));
    mkdirSync(multiDir, { recursive: true });
    const filePath = join(multiDir, 'rollout-multi.jsonl');
    const lines = [
      { type: 'session_meta', timestamp: 't0', payload: { id: 'multi-reason-session', cwd: PROJECT_PATH, timestamp: 't0' } },
      { type: 'response_item', timestamp: 't1', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'première étape' }] } },
      { type: 'response_item', timestamp: 't2', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'deuxième étape' }] } },
      {
        type: 'response_item',
        timestamp: 't3',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Réponse finale.' }] },
      },
    ];
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, { filePath });
    const messages = db.getMessagesForThread('multi-reason-session');
    expect(messages).toHaveLength(1); // both reasoning steps + the reply collapse into one message
    expect(messages[0].thought).toBe('première étape\n\ndeuxième étape');
    expect(messages[0].content).toBe('Réponse finale.');

    rmSync(multiDir, { recursive: true, force: true });
  });

  it('attaches the real model + token usage from turn_context/token_count events to the assistant message that turn produced', () => {
    const usageDir = mkdtempSync(join(tmpdir(), 'sync-hub-codex-usage-'));
    const filePath = join(usageDir, 'rollout-usage.jsonl');
    const lines = [
      { type: 'session_meta', timestamp: 't0', payload: { id: 'usage-session', cwd: PROJECT_PATH, timestamp: 't0' } },
      { type: 'turn_context', timestamp: 't1', payload: { model: 'gpt-5.5' } },
      {
        type: 'response_item',
        timestamp: 't2',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour' }] },
      },
      {
        type: 'response_item',
        timestamp: 't3',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Réponse.' }] },
      },
      {
        type: 'event_msg',
        timestamp: 't4',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 18355, output_tokens: 41, cached_input_tokens: 16768, reasoning_output_tokens: 12 } },
        },
      },
    ];
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, { filePath });
    const messages = db.getMessagesForThread('usage-session');
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.model).toBe('gpt-5.5');
    expect(assistantMsg?.usage).toEqual({ inputTokens: 18355, outputTokens: 41, cachedInputTokens: 16768, reasoningOutputTokens: 12 });
    // The user message from the same turn must not carry usage — only the last ParsedLine per turn does.
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.model).toBeUndefined();
    expect(userMsg?.usage).toBeUndefined();

    rmSync(usageDir, { recursive: true, force: true });
  });

  it('resolves a session whose cwd is Codex\'s own ChatGPT-Project cache folder to the matching ChatGPT Project, auto-creating it — regression for a real find (several such sessions sat unassigned)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sync-hub-codex-cache-cwd-'));
    const cwd = join(cacheDir, '.codex', '.chatgpt-projects', 'g-p-realfindtest0001');
    mkdirSync(cwd, { recursive: true });
    const filePath = join(cacheDir, 'rollout-cache-cwd.jsonl');
    const lines = [
      { type: 'session_meta', timestamp: 't0', payload: { id: 'cache-cwd-session', cwd, timestamp: 't0' } },
      {
        type: 'response_item',
        timestamp: 't1',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fait le point sur ce projet.' }] },
      },
    ];
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, { filePath });

    const thread = db.getThread('cache-cwd-session');
    expect(thread?.projectId).toBe('chatgpt-project-g-p-realfindtest0001');
    expect(db.getProject('chatgpt-project-g-p-realfindtest0001')?.name).toBe('g-p-realfindtest0001'); // no cached name available — falls back to the raw id, not a guess

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('uses the real cached ChatGPT Project name (from Codex\'s own AGENTS.md mirror) instead of the raw id — regression for a real find: "C00125 - Acritec" was silently dropped in favor of "g-p-…"', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sync-hub-codex-cache-cwd-named-'));
    const projectsCacheRoot = join(cacheDir, '.chatgpt-projects');
    const cwd = join(cacheDir, '.codex', '.chatgpt-projects', 'g-p-namedtest0002');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(projectsCacheRoot, 'g-p-namedtest0002'), { recursive: true });
    writeFileSync(
      join(projectsCacheRoot, 'g-p-namedtest0002', 'AGENTS.md'),
      '# ChatGPT project context\n\nThis directory is a local mirror of the ChatGPT project “C00125 - Acritec”.\n',
    );
    const filePath = join(cacheDir, 'rollout-cache-cwd-named.jsonl');
    const lines = [
      { type: 'session_meta', timestamp: 't0', payload: { id: 'named-cache-cwd-session', cwd, timestamp: 't0' } },
      {
        type: 'response_item',
        timestamp: 't1',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fait le point sur ce projet.' }] },
      },
    ];
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    ingestSessionFile(db, registry, { filePath }, { chatGptProjectsCacheRoot: projectsCacheRoot });

    expect(db.getThread('named-cache-cwd-session')?.projectId).toBe('chatgpt-project-g-p-namedtest0002');
    expect(db.getProject('chatgpt-project-g-p-namedtest0002')?.name).toBe('C00125 - Acritec');

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('routes an unregistered cwd to the unassigned bucket, never guessing', () => {
    const refs = discoverSessionFiles([FIXTURE_ROOT]);
    db.raw.prepare('DELETE FROM projects WHERE id = ?').run('proj-demo');
    ingestSessionFile(db, registry, refs[0]);
    expect(db.getThread('fixture-session-0002')?.projectId).toBe(UNASSIGNED_PROJECT_ID);
  });
});
