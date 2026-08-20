import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import { computeMessageHash } from '../hash.js';
import { ensureChatGptProject, loadChatGptProjectNames } from './chatgpt-export.js';
import type { Message, MessageRole, Thread, ToolCall, ToolResult, TokenUsage } from '../../types.js';

export const CODEX_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
export const CODEX_ARCHIVED_SESSIONS_ROOT = join(homedir(), '.codex', 'archived_sessions');

// Codex creates its own internal cache folder per ChatGPT Project it has ever touched
// (~/.codex/.chatgpt-projects/g-p-<id>/) and sometimes runs actual sessions with their cwd set to
// that exact folder (verified on real data: several such sessions existed, all landing in
// "unassigned" because that path never matches a real project's own folder). Since the id in the
// path is the same real ChatGPT Project template id used elsewhere, these resolve straight to that
// project instead — the same real identity, not a guess.
const CHATGPT_PROJECT_CACHE_CWD = /[/\\]\.codex[/\\]\.chatgpt-projects[/\\](g-p-[a-zA-Z0-9]+)(?:[/\\]|$)/;

function resolveCodexCwd(db: Db, registry: ProjectRegistry, cwd: string, chatGptProjectsCacheRoot?: string): string {
  const cacheMatch = cwd.match(CHATGPT_PROJECT_CACHE_CWD);
  if (cacheMatch) {
    const templateId = cacheMatch[1];
    // Real cached name if Codex has ever synced this ChatGPT Project's AGENTS.md (verified: a
    // real name like "C00125 - Acritec" was found here and silently dropped in favor of the raw
    // id before this fix) — same lookup ingestChatGptExport uses, so both paths agree on a name.
    const name = loadChatGptProjectNames(chatGptProjectsCacheRoot).get(templateId) ?? templateId;
    return ensureChatGptProject(db, templateId, name, new Date().toISOString());
  }
  return registry.resolveByCodexCwd(cwd);
}

export interface SessionFileRef {
  filePath: string;
}

function walkJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (entry.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

export function discoverSessionFiles(roots: string[] = [CODEX_SESSIONS_ROOT, CODEX_ARCHIVED_SESSIONS_ROOT]): SessionFileRef[] {
  const files = roots.flatMap((root) => walkJsonlFiles(root));
  return files.map((filePath) => ({ filePath }));
}

interface ParsedLine {
  role: MessageRole;
  content: string;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: string;
  uuid: string;
  model?: string;
  usage?: TokenUsage;
}

function textFromContentBlocks(blocks: any[]): string {
  return blocks
    .filter((b) => b?.type === 'input_text' || b?.type === 'output_text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/**
 * Codex injects system notices as role:"user" messages wrapped in one of these tags (verified
 * against real sessions: 88 environment_context, 58 task-notification, 28 recommended_plugins,
 * plus the rest below, across an 80-file sample) — not something the human actually typed. Left
 * in, the first one of these often became a thread's derived title instead of the real prompt.
 */
const SYNTHETIC_USER_TAGS = new Set([
  'environment_context',
  'task-notification',
  'recommended_plugins',
  'command-name',
  'command-message',
  'local-command-stdout',
  'turn_aborted',
  'image',
  'skill',
  'uploaded_files',
]);

function isSyntheticUserNotice(text: string): boolean {
  const match = text.match(/^\s*<([a-zA-Z_-]+)>/);
  return !!match && SYNTHETIC_USER_TAGS.has(match[1]);
}

/**
 * When the user @-mentions an app or attaches a file, Codex prepends a real preamble — "# Applications
 * mentioned by the user:" / "# Files mentioned by the user:" with plugin/file links — to the *same*
 * message as the actual typed text, ending with a literal "## My request:" line (verified: 10/902 real
 * user messages in a 400-session sample). That preamble isn't something Robin typed, so only the text
 * after the marker is kept as the verbatim message — the rest is Codex's own bookkeeping, same
 * reasoning as isSyntheticUserNotice above, just for a mixed message instead of a pure-notice one.
 */
const MY_REQUEST_MARKER_RE = /^[\s\S]*?\n## My request:\n/;

function stripInjectedRequestPreamble(text: string): string {
  const match = text.match(MY_REQUEST_MARKER_RE);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Parses one raw JSONL line from a Codex rollout file. Returns null for session bookkeeping
 * (session_meta, turn_context, world_state, compacted) and non-conversational event_msg types.
 * `response_item` is the raw, verbatim API-level record and is preferred over the higher-level
 * `event_msg` stream (which duplicates the same content in a pre-digested form) — except for
 * `thread_name_updated`, surfaced separately by the caller since Codex assigns it, not us.
 */
export function parseLine(rawLine: string): ParsedLine | null {
  const line = rawLine.trim();
  if (!line) return null;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (event.type !== 'response_item') return null;
  const payload = event.payload ?? {};
  const timestamp = event.timestamp ?? new Date(0).toISOString();
  const uuid = createHash('sha256').update(line).digest('hex').slice(0, 16);

  switch (payload.type) {
    case 'message': {
      if (payload.role === 'developer') return null; // Codex's own injected permission/system boilerplate.
      const role: MessageRole = payload.role === 'assistant' ? 'assistant' : 'user';
      let content = textFromContentBlocks(payload.content ?? []);
      if (!content) return null;
      if (role === 'user' && isSyntheticUserNotice(content)) return null;
      if (role === 'user') content = stripInjectedRequestPreamble(content);
      return { role, content, timestamp, uuid };
    }
    case 'reasoning': {
      // OpenAI's Responses API encrypts the full reasoning trace server-side — only this
      // short, Codex-generated summary is ever available in plaintext, to anyone, anywhere.
      const summary = (payload.summary ?? [])
        .filter((s: any) => s?.type === 'summary_text')
        .map((s: any) => s.text)
        .join('\n');
      if (!summary) return null;
      return { role: 'assistant', content: '', thought: summary, timestamp, uuid };
    }
    case 'function_call': {
      let args: unknown = payload.arguments;
      try {
        args = JSON.parse(payload.arguments);
      } catch {
        // leave as raw string if it isn't valid JSON
      }
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: payload.call_id, name: payload.name, arguments: args }],
        timestamp,
        uuid,
      };
    }
    case 'custom_tool_call': {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: payload.call_id, name: payload.name, arguments: payload.input }],
        timestamp,
        uuid,
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      return {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: payload.call_id, name: payload.call_id, output, status: 'success' }],
        timestamp,
        uuid,
      };
    }
    default:
      return null;
  }
}

/**
 * Codex logs a reasoning summary as its own response_item, immediately before the assistant
 * turn it led to (a text reply, or a tool call) — as far as the user is concerned that reasoning
 * IS part of that turn, not a separate message, so it's folded into the next assistant-authored
 * entry's `thought` field here rather than counted as its own message. A reasoning entry with no
 * following assistant entry to attach to (rare — only possible at the very end of a tail read
 * that lands exactly between the two) is flushed standalone rather than silently dropped.
 */
function mergeReasoningIntoFollowingMessage(parsed: ParsedLine[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  let pending: string | undefined;

  for (const p of parsed) {
    const isReasoningOnly = p.role === 'assistant' && !p.content && p.thought && !p.toolCalls && !p.toolResults;
    if (isReasoningOnly) {
      pending = pending ? `${pending}\n\n${p.thought}` : p.thought;
      continue;
    }
    if (pending && p.role === 'assistant') {
      out.push({ ...p, thought: p.thought ? `${pending}\n\n${p.thought}` : pending });
      pending = undefined;
    } else {
      out.push(p);
    }
  }
  if (pending) {
    const last = parsed[parsed.length - 1];
    out.push({ role: 'assistant', content: '', thought: pending, timestamp: last?.timestamp ?? new Date().toISOString(), uuid: `${last?.uuid ?? 'eof'}-thought` });
  }
  return out;
}

/**
 * Attaches the real model + token usage Codex reports for each API turn to the ParsedLine(s) that
 * turn produced — verified against real sessions: `turn_context` events carry the model in use
 * from that point on, and `event_msg/token_count` events follow *after* the response_item(s) a
 * turn produced (reasoning, then a message and/or function_call), reporting `last_token_usage` —
 * the real delta for that turn, not a running total. Neither is attached to a response_item
 * directly, so this is a stateful pass rather than something parseLine (pure, one line at a time)
 * can do alone. When a turn produced more than one ParsedLine (e.g. a text reply *and* a tool
 * call), the usage is attached to only the last one — real tokens were spent producing both, but
 * attaching to every one of them would double-count that turn's usage in any later cost total.
 */
function parseLinesWithUsage(lines: string[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  let currentModel: string | undefined;
  let lastAssistantIndex = -1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'turn_context') {
      currentModel = typeof event.payload?.model === 'string' ? event.payload.model : currentModel;
      continue;
    }
    if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const u = event.payload?.info?.last_token_usage;
      if (u && lastAssistantIndex !== -1) {
        out[lastAssistantIndex].model = currentModel;
        out[lastAssistantIndex].usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cachedInputTokens: u.cached_input_tokens || undefined,
          reasoningOutputTokens: u.reasoning_output_tokens || undefined,
        };
      }
      continue;
    }

    const parsed = parseLine(line);
    if (!parsed) continue;
    out.push(parsed);
    if (parsed.role === 'assistant') lastAssistantIndex = out.length - 1;
  }
  return out;
}

interface SessionHeader {
  sessionId: string;
  cwd: string | undefined;
  createdAt: string | undefined;
  threadName: string | undefined;
}

/** session_meta is always the first line; thread_name_updated (if present) can appear anywhere after. */
function readSessionHeader(lines: string[]): SessionHeader | null {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let threadName: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session_meta' && !sessionId) {
      sessionId = event.payload?.id;
      cwd = event.payload?.cwd;
      createdAt = event.payload?.timestamp ?? event.timestamp;
    } else if (event.type === 'event_msg' && event.payload?.type === 'thread_name_updated') {
      threadName = event.payload?.thread_name;
    }
  }
  return sessionId ? { sessionId, cwd, createdAt, threadName } : null;
}

function deriveTitle(header: SessionHeader, firstUserContent: string | undefined): string {
  if (header.threadName) return header.threadName;
  if (firstUserContent) {
    const oneLine = firstUserContent.replace(/\s+/g, ' ').trim();
    if (oneLine) return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  return `Session ${header.sessionId.slice(0, 8)}`;
}

export function ingestSessionFile(
  db: Db,
  registry: ProjectRegistry,
  ref: SessionFileRef,
  opts: { fromOffset?: number; chatGptProjectsCacheRoot?: string } = {},
): number {
  const eventType = opts.fromOffset ? 'watch_tail' : 'full_scan';
  let raw: string;
  try {
    raw = readFileSync(ref.filePath, 'utf-8');
  } catch (err: any) {
    db.logIngestEvent({ engine: 'codex', filePath: ref.filePath, eventType, status: 'error', message: err?.message, timestamp: new Date().toISOString() });
    return 0;
  }

  const allLines = raw.split('\n');
  const header = readSessionHeader(allLines);
  if (!header) {
    db.logIngestEvent({
      engine: 'codex',
      filePath: ref.filePath,
      eventType,
      status: 'skipped_duplicate',
      message: 'aucun session_meta trouvé — fichier ignoré',
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  const projectId = header.cwd ? resolveCodexCwd(db, registry, header.cwd, opts.chatGptProjectsCacheRoot) : 'unassigned';
  const existingThread = db.getThread(header.sessionId);

  if (!existingThread) {
    const now = header.createdAt ?? new Date().toISOString();
    db.upsertThread({
      id: header.sessionId,
      projectId,
      title: `Session ${header.sessionId.slice(0, 8)}`,
      originEngine: 'codex',
      engineIds: { codex: header.sessionId },
      sourceRef: header.cwd,
      sourceFilePath: ref.filePath,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    } as Thread);
  }

  const body = opts.fromOffset ? raw.slice(opts.fromOffset) : raw;
  const lines = body.split('\n');
  const parsedLines = mergeReasoningIntoFollowingMessage(parseLinesWithUsage(lines));

  let sequence = existingThread ? db.getMessagesForThread(header.sessionId).length : 0;
  let firstUserContent: string | undefined;
  let inserted = 0;
  let latestTimestamp = existingThread?.updatedAt ?? header.createdAt;

  for (const parsed of parsedLines) {
    if (parsed.role === 'user' && firstUserContent === undefined) firstUserContent = parsed.content;

    const hash = computeMessageHash(parsed.role, parsed.content, parsed.thought, parsed.toolCalls, parsed.toolResults);
    const message: Message = {
      id: parsed.uuid,
      threadId: header.sessionId,
      projectId,
      sourceEngine: 'codex',
      role: parsed.role,
      content: parsed.content,
      thought: parsed.thought,
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
      timestamp: parsed.timestamp,
      sequence: sequence++,
      hash,
      model: parsed.model,
      usage: parsed.usage,
    };
    if (db.insertMessage(message)) inserted++;
    latestTimestamp = parsed.timestamp;
  }

  const now = new Date().toISOString();
  db.upsertThread({
    id: header.sessionId,
    projectId,
    title: deriveTitle(header, firstUserContent),
    originEngine: 'codex',
    engineIds: { codex: header.sessionId },
    sourceRef: header.cwd,
      sourceFilePath: ref.filePath,
    messageCount: sequence,
    createdAt: existingThread?.createdAt ?? header.createdAt ?? now,
    updatedAt: latestTimestamp ?? now,
    status: 'active',
  } as Thread);

  if (projectId) db.touchProjectActivity(projectId, latestTimestamp ?? now);

  db.logIngestEvent({
    engine: 'codex',
    filePath: ref.filePath,
    eventType,
    status: 'ok',
    message: `${inserted} nouveau(x) message(s)`,
    timestamp: now,
  });

  return inserted;
}

export function ingestAll(db: Db, registry: ProjectRegistry, chatGptProjectsCacheRoot?: string): number {
  let total = 0;
  for (const ref of discoverSessionFiles()) {
    total += ingestSessionFile(db, registry, ref, { chatGptProjectsCacheRoot });
  }
  return total;
}

export function storageRootExists(): boolean {
  return existsSync(CODEX_SESSIONS_ROOT);
}
