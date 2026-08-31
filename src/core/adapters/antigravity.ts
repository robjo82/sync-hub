import { createHash } from 'node:crypto';
import { existsSync, readdirSync} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { encode } from 'gpt-tokenizer';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import { computeMessageHash } from '../hash.js';
import { UNASSIGNED_PROJECT_ID, type Message, type MessageRole, type Thread, type ToolCall, type ToolResult } from '../../types.js';
import { readJsonlFrom } from '../jsonl-tail.js';

export const ANTIGRAVITY_BRAIN_ROOT = join(homedir(), '.gemini', 'antigravity', 'brain');
export const ANTIGRAVITY_CLI_BRAIN_ROOT = join(homedir(), '.gemini', 'antigravity-cli', 'brain');

/**
 * Antigravity's real storage was reverse-engineered from Robin's live sessions (Aug 2026): the
 * primary `conversations/<id>.db` SQLite/protobuf store has no available schema and encrypts
 * tool-result payloads at rest, but every session also gets a plaintext, line-delimited JSON
 * transcript at this path — same event data, already verbatim text, no decoding required.
 */
const TRANSCRIPT_RELATIVE_PATH = ['.system_generated', 'logs', 'transcript_full.jsonl'];
const TRANSCRIPT_FILENAME = 'transcript_full.jsonl';

export interface SessionFileRef {
  filePath: string;
  sessionId: string;
}

export function discoverSessionFiles(root: string = ANTIGRAVITY_BRAIN_ROOT): SessionFileRef[] {
  const roots = root === ANTIGRAVITY_BRAIN_ROOT ? [ANTIGRAVITY_BRAIN_ROOT, ANTIGRAVITY_CLI_BRAIN_ROOT] : [root];
  const out: SessionFileRef[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const sessionId of readdirSync(r)) {
      const filePath = join(r, sessionId, ...TRANSCRIPT_RELATIVE_PATH);
      if (existsSync(filePath)) out.push({ filePath, sessionId });
    }
  }
  return out;
}

/** Used by the watch engine, which only knows a changed file's path. Null for any file that isn't a transcript. */
export function refFromFilePath(filePath: string): SessionFileRef | null {
  if (basename(filePath) !== TRANSCRIPT_FILENAME) return null;
  // .../brain/<sessionId>/.system_generated/logs/transcript_full.jsonl
  const sessionId = basename(dirname(dirname(dirname(filePath))));
  return { filePath, sessionId };
}

interface ParsedLine {
  role: MessageRole;
  content: string;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: string;
  uuid: string;
}

const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

/** Token-counts everything this message's real API turn would actually have sent/produced —
 * content and thought as plain text, tool calls/results serialized the same way they're stored
 * in the DB — so a message that's mostly a tool call isn't undercounted as if it were empty. */
function estimateMessageTokens(content: string, thought?: string, toolCalls?: ToolCall[], toolResults?: ToolResult[]): number {
  const parts = [content, thought, toolCalls?.length ? JSON.stringify(toolCalls) : undefined, toolResults?.length ? JSON.stringify(toolResults) : undefined];
  const text = parts.filter(Boolean).join('\n');
  return text ? encode(text).length : 0;
}

/**
 * Parses one line of transcript_full.jsonl. Verified event shapes (real data, both of Robin's
 * open sessions): `USER_EXPLICIT/USER_INPUT` wraps the literal typed text in a <USER_REQUEST>
 * tag alongside system-injected <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> — only the tagged
 * text is verbatim user input, so that's what's extracted (falls back to the raw content if the
 * tag is ever absent, rather than dropping the line). `MODEL/PLANNER_RESPONSE` carries either the
 * turn's final reply (`content`) or an intermediate reasoning/tool-call step (`thinking`/
 * `tool_calls`, no `content`) — both are real and kept as their own sequenced message rather than
 * merged, since a turn can end mid-tool-call with no final reply yet (true of one of Robin's two
 * open sessions at the time this was written). `MODEL/GENERIC` is tool-result narration text with
 * no id linking it back to a specific call — kept as its own 'tool' message instead of guessing a
 * pairing the source data doesn't provide. `SYSTEM/CHECKPOINT` is internal context-truncation
 * bookkeeping, not conversational content, and is skipped like Codex's session_meta/turn_context.
 */
export function parseLine(rawLine: string, sessionId: string): ParsedLine | null {
  const line = rawLine.trim();
  if (!line) return null;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const timestamp = typeof event.created_at === 'string' ? event.created_at : new Date(0).toISOString();
  const uuid = createHash('sha256').update(`${sessionId}:${line}`).digest('hex').slice(0, 16);
  const stepIndex = event.step_index;

  if (event.source === 'USER_EXPLICIT' && event.type === 'USER_INPUT') {
    const raw = typeof event.content === 'string' ? event.content : '';
    const match = raw.match(USER_REQUEST_RE);
    const content = (match ? match[1] : raw).trim();
    if (!content) return null;
    return { role: 'user', content, timestamp, uuid };
  }

  if (event.source === 'MODEL' && event.type === 'PLANNER_RESPONSE') {
    const content = typeof event.content === 'string' ? event.content : '';
    const thought = typeof event.thinking === 'string' ? event.thinking : undefined;
    const toolCalls: ToolCall[] | undefined =
      Array.isArray(event.tool_calls) && event.tool_calls.length > 0
        ? event.tool_calls.map((tc: any, i: number) => ({
            id: `${sessionId}-${stepIndex}-${i}`,
            name: typeof tc?.name === 'string' ? tc.name : 'unknown',
            arguments: tc?.args,
          }))
        : undefined;
    if (!content && !thought && !toolCalls) return null;
    return { role: 'assistant', content, thought, toolCalls, timestamp, uuid };
  }

  if (event.source === 'MODEL' && event.type === 'GENERIC') {
    const output = typeof event.content === 'string' ? event.content : '';
    if (!output) return null;
    return {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `${sessionId}-${stepIndex}`, name: 'tool_result', output, status: 'success' }],
      timestamp,
      uuid,
    };
  }

  if (event.source === 'SYSTEM' && event.type === 'SYSTEM_MESSAGE') {
    const content = typeof event.content === 'string' ? event.content : '';
    if (!content) return null;
    return { role: 'system', content, timestamp, uuid };
  }

  return null;
}

function deriveTitle(firstUserContent: string | undefined, sessionId: string): string {
  if (!firstUserContent) return `Session ${sessionId.slice(0, 8)}`;
  const oneLine = firstUserContent.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine || `Session ${sessionId.slice(0, 8)}`;
}

/**
 * Full ingestion of one Antigravity session. Unlike Claude Code/Codex, there is no reliable real
 * project-path signal to resolve against: the session's own recorded cwd is always a sandboxed
 * scratch git repo under ~/Documents/antigravity/<random-slug> (verified on real data — freshly
 * initialized, no remote, no link back to the real folder the user actually opened Antigravity
 * against). That's the same class of problem that put Claude Cowork's VM-sandboxed cwd out of
 * consideration for auto-resolution (see cowork.ts) — every Antigravity session lands in
 * "unassigned" for manual triage instead of being guessed from a real path that happens to
 * surface inside a tool call's arguments.
 */
export function ingestSessionFile(
  db: Db,
  _registry: ProjectRegistry,
  ref: SessionFileRef,
  opts: { fromOffset?: number } = {},
): number {
  const eventType = opts.fromOffset ? 'watch_tail' : 'full_scan';
  const raw = readJsonlFrom(ref.filePath, opts.fromOffset);
  if (raw === null) {
    db.logIngestEvent({
      engine: 'antigravity',
      filePath: ref.filePath,
      eventType,
      status: 'error',
      message: 'unreadable',
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  const lines = raw.split('\n');
  const existingThread = db.getThread(ref.sessionId);
  const projectId = existingThread && existingThread.projectId !== UNASSIGNED_PROJECT_ID ? existingThread.projectId : UNASSIGNED_PROJECT_ID;

  if (!existingThread) {
    // messages.thread_id is a foreign key — the thread row must exist before any message does.
    const now = new Date().toISOString();
    db.upsertThread({
      id: ref.sessionId,
      projectId,
      title: `Session ${ref.sessionId.slice(0, 8)}`,
      originEngine: 'antigravity',
      engineIds: { antigravity: ref.sessionId },
      sourceFilePath: ref.filePath,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    } as Thread);
  }

  let sequence = existingThread ? db.getMessagesForThread(ref.sessionId).length : 0;
  let firstUserContent: string | undefined;
  let inserted = 0;
  let latestTimestamp = existingThread?.updatedAt;

  for (const rawLine of lines) {
    const parsed = parseLine(rawLine, ref.sessionId);
    if (!parsed) continue;
    if (parsed.role === 'user' && firstUserContent === undefined) firstUserContent = parsed.content;

    const hash = computeMessageHash(parsed.role, parsed.content, parsed.thought, parsed.toolCalls, parsed.toolResults);
    const message: Message = {
      id: parsed.uuid,
      threadId: ref.sessionId,
      projectId,
      sourceEngine: 'antigravity',
      role: parsed.role,
      content: parsed.content,
      thought: parsed.thought,
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
      timestamp: parsed.timestamp,
      sequence: sequence++,
      hash,
      // Antigravity never reports real token usage — computed once here (not at cost-query time,
      // which used to re-tokenize the whole corpus on every /api/costs call: ~2s measured on the
      // real ~6,500-message history) so db.ts's cost estimation is just a cheap running sum over
      // an already-computed column. Only this engine gets this field: it's a real-usage engine's
      // job to report its own usage, never sync-hub's job to guess for engines that already do.
      estimatedTokens: estimateMessageTokens(parsed.content, parsed.thought, parsed.toolCalls, parsed.toolResults),
    };
    if (db.insertMessage(message)) inserted++;
    latestTimestamp = parsed.timestamp;
  }

  const now = new Date().toISOString();
  db.upsertThread({
    id: ref.sessionId,
    projectId,
    title: existingThread?.title ?? deriveTitle(firstUserContent, ref.sessionId),
    originEngine: 'antigravity',
    engineIds: { antigravity: ref.sessionId },
    sourceFilePath: ref.filePath,
    messageCount: sequence,
    createdAt: existingThread?.createdAt ?? latestTimestamp ?? now,
    updatedAt: latestTimestamp ?? now,
    status: 'active',
  } as Thread);

  db.touchProjectActivity(projectId, latestTimestamp ?? now);

  db.logIngestEvent({
    engine: 'antigravity',
    filePath: ref.filePath,
    eventType,
    status: 'ok',
    message: `${inserted} nouveau(x) message(s)`,
    timestamp: now,
  });

  return inserted;
}

export function ingestAll(db: Db, registry: ProjectRegistry, root: string = ANTIGRAVITY_BRAIN_ROOT): number {
  let total = 0;
  for (const ref of discoverSessionFiles(root)) {
    total += ingestSessionFile(db, registry, ref);
  }
  return total;
}

export function storageRootExists(root: string = ANTIGRAVITY_BRAIN_ROOT): boolean {
  if (root === ANTIGRAVITY_BRAIN_ROOT) {
    return existsSync(ANTIGRAVITY_BRAIN_ROOT) || existsSync(ANTIGRAVITY_CLI_BRAIN_ROOT);
  }
  return existsSync(root);
}
