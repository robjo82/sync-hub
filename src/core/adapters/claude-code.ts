import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import { computeMessageHash } from '../hash.js';
import type { Message, MessageRole, Thread, ToolCall, ToolResult, TokenUsage } from '../../types.js';

export const CLAUDE_CODE_STORAGE_ROOT = join(homedir(), '.claude', 'projects');

export interface SessionFileRef {
  filePath: string;
  /** Directory name under .claude/projects — Claude Code's own slug for the project path. */
  slug: string;
  sessionId: string;
}

/** Event types in Claude Code's JSONL that carry no conversational content — UI/session bookkeeping. */
const NON_MESSAGE_TYPES = new Set([
  'attachment',
  'system',
  'mode',
  'last-prompt',
  'ai-title',
  'custom-title',
  'queue-operation',
  'frame-link',
]);

export function discoverSessionFiles(root: string = CLAUDE_CODE_STORAGE_ROOT): SessionFileRef[] {
  if (!existsSync(root)) return [];
  const refs: SessionFileRef[] = [];
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    let files: string[];
    try {
      files = readdirSync(slugDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      refs.push({ filePath: join(slugDir, file), slug, sessionId: basename(file, '.jsonl') });
    }
  }
  return refs;
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

/**
 * Claude Code's own `usage` object on an assistant event, mapped to the shared TokenUsage shape —
 * verified against real sessions: `cache_creation` already splits 5-minute vs 1-hour writes, so
 * both are captured exactly rather than assumed. `model: "<synthetic>"` marks an event Claude Code
 * generated itself (no real API call, no real usage) — never priced, so it's dropped entirely
 * rather than kept as a model id with no matching price.
 */
function usageFromClaudeCodeMessage(message: any): { model?: string; usage?: TokenUsage } {
  const model = typeof message?.model === 'string' && message.model !== '<synthetic>' ? message.model : undefined;
  const rawUsage = message?.usage;
  if (!model || !rawUsage) return { model };
  const usage: TokenUsage = {
    inputTokens: rawUsage.input_tokens ?? 0,
    outputTokens: rawUsage.output_tokens ?? 0,
    cacheCreation5mInputTokens: rawUsage.cache_creation?.ephemeral_5m_input_tokens || undefined,
    cacheCreation1hInputTokens: rawUsage.cache_creation?.ephemeral_1h_input_tokens || undefined,
    cacheReadInputTokens: rawUsage.cache_read_input_tokens || undefined,
  };
  return { model, usage };
}

/** Parses one raw JSONL line. Returns null for non-conversational event types (system/UI bookkeeping). */
export function parseLine(rawLine: string): ParsedLine | null {
  const line = rawLine.trim();
  if (!line) return null;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const type = event.type;
  if (NON_MESSAGE_TYPES.has(type)) return null;
  if (type !== 'user' && type !== 'assistant') return null;

  const content = event.message?.content;
  const timestamp = event.timestamp ?? new Date(0).toISOString();
  const uuid = event.uuid ?? createHash('sha256').update(line).digest('hex').slice(0, 16);

  if (typeof content === 'string') {
    // A plain human message.
    return { role: 'user', content, timestamp, uuid };
  }

  if (!Array.isArray(content)) return null;

  if (type === 'user') {
    // Tool results are delivered as type:"user" events with tool_result blocks in this schema.
    const toolResults: ToolResult[] = [];
    const textParts: string[] = [];
    for (const block of content) {
      if (block?.type === 'tool_result') {
        toolResults.push({
          toolCallId: block.tool_use_id,
          name: block.tool_use_id, // Claude Code doesn't echo the tool name on the result block; id is the join key.
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          status: block.is_error ? 'error' : 'success',
        });
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (toolResults.length === 0 && textParts.length === 0) return null;
    return {
      role: toolResults.length > 0 && textParts.length === 0 ? 'tool' : 'user',
      content: textParts.join('\n'),
      toolResults: toolResults.length ? toolResults : undefined,
      timestamp,
      uuid,
    };
  }

  // type === 'assistant'
  const textParts: string[] = [];
  const thoughtParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      thoughtParts.push(block.thinking);
    } else if (block?.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
  }
  if (textParts.length === 0 && thoughtParts.length === 0 && toolCalls.length === 0) return null;
  return {
    role: 'assistant',
    content: textParts.join('\n'),
    thought: thoughtParts.length ? thoughtParts.join('\n') : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    timestamp,
    uuid,
    ...usageFromClaudeCodeMessage(event.message),
  };
}

function deriveTitle(firstUserContent: string | undefined, sessionId: string): string {
  if (!firstUserContent) return `Session ${sessionId.slice(0, 8)}`;
  const oneLine = firstUserContent.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine || `Session ${sessionId.slice(0, 8)}`;
}

/**
 * Full ingestion of one session file: resolves its project via the Claude-Code-native slug
 * (never guessed), upserts the thread, and inserts every message (hash-deduped, so re-running
 * this on an already-ingested file is a no-op).
 */
export function ingestSessionFile(
  db: Db,
  registry: ProjectRegistry,
  ref: SessionFileRef,
  opts: { fromOffset?: number; projectIdOverride?: string } = {},
): number {
  let raw: string;
  try {
    raw = readFileSync(ref.filePath, 'utf-8');
  } catch (err: any) {
    db.logIngestEvent({
      engine: 'claude-code',
      filePath: ref.filePath,
      eventType: opts.fromOffset ? 'watch_tail' : 'full_scan',
      status: 'error',
      message: err?.message,
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  const body = opts.fromOffset ? raw.slice(opts.fromOffset) : raw;
  const lines = body.split('\n');
  // Cowork sessions pass an override here: their slug is derived from a VM-sandboxed cwd and is
  // meaningless for project resolution — the real signal is the user-selected folder, if any.
  const projectId = opts.projectIdOverride ?? registry.resolveByClaudeSlug(ref.slug);

  const existingThread = db.getThread(ref.sessionId);
  let sequence = existingThread ? db.getMessagesForThread(ref.sessionId).length : 0;
  let firstUserContent: string | undefined;
  let inserted = 0;
  let latestTimestamp = existingThread?.updatedAt;

  if (!existingThread) {
    // messages.thread_id is a foreign key — the thread row must exist before any message does.
    const now = new Date().toISOString();
    db.upsertThread({
      id: ref.sessionId,
      projectId,
      title: `Session ${ref.sessionId.slice(0, 8)}`,
      originEngine: 'claude-code',
      engineIds: { 'claude-code': ref.sessionId },
      sourceRef: ref.slug,
      sourceFilePath: ref.filePath,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    } as Thread);
  }

  for (const rawLine of lines) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    if (parsed.role === 'user' && firstUserContent === undefined) firstUserContent = parsed.content;

    const hash = computeMessageHash(parsed.role, parsed.content, parsed.thought, parsed.toolCalls, parsed.toolResults);
    const message: Message = {
      id: parsed.uuid,
      threadId: ref.sessionId,
      projectId,
      sourceEngine: 'claude-code',
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
    id: ref.sessionId,
    projectId,
    title: existingThread?.title ?? deriveTitle(firstUserContent, ref.sessionId),
    originEngine: 'claude-code',
    engineIds: { 'claude-code': ref.sessionId },
    sourceRef: ref.slug,
      sourceFilePath: ref.filePath,
    messageCount: sequence,
    createdAt: existingThread?.createdAt ?? latestTimestamp ?? now,
    updatedAt: latestTimestamp ?? now,
    status: 'active',
  } as Thread);

  if (projectId) db.touchProjectActivity(projectId, latestTimestamp ?? now);

  db.logIngestEvent({
    engine: 'claude-code',
    filePath: ref.filePath,
    eventType: opts.fromOffset ? 'watch_tail' : 'full_scan',
    status: 'ok',
    message: `${inserted} nouveau(x) message(s)`,
    timestamp: now,
  });

  return inserted;
}

export function ingestAll(db: Db, registry: ProjectRegistry, root: string = CLAUDE_CODE_STORAGE_ROOT): number {
  let total = 0;
  for (const ref of discoverSessionFiles(root)) {
    total += ingestSessionFile(db, registry, ref);
  }
  return total;
}

export function storageRootExists(root: string = CLAUDE_CODE_STORAGE_ROOT): boolean {
  return existsSync(root);
}

// Re-exported for the watch engine, which needs to know a file's slug from its path alone.
export function refFromFilePath(filePath: string): SessionFileRef {
  return { filePath, slug: basename(dirname(filePath)), sessionId: basename(filePath, '.jsonl') };
}
