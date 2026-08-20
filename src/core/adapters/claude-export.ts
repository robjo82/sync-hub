import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { computeMessageHash } from '../hash.js';
import type { Message, MessageRole, Thread, ToolCall, ToolResult } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';

interface ExportMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  content?: Array<Record<string, any>>;
  text?: string;
  created_at: string;
}

interface ExportConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ExportMessage[];
}

/**
 * Web conversations carry no cwd/project signal at all (unlike a CLI session) — every imported
 * thread lands in "unassigned" and needs a human to triage it via the same assign flow used for
 * ambiguous CLI sessions. This is expected, not a bug: there is nothing to resolve against.
 */
function toCanonicalMessage(msg: ExportMessage, threadId: string, sequence: number): Message | null {
  const role: MessageRole = msg.sender === 'human' ? 'user' : 'assistant';
  const textParts: string[] = [];
  const thoughtParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];

  for (const block of msg.content ?? []) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') textParts.push(block.text);
        break;
      case 'thinking':
        if (typeof block.text === 'string') thoughtParts.push(block.text);
        break;
      case 'tool_use':
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
        break;
      case 'tool_result': {
        const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        toolResults.push({ toolCallId: block.tool_use_id, name: block.name, output, status: block.is_error ? 'error' : 'success' });
        break;
      }
      // 'token_budget' and anything else: metering/telemetry, not conversational content.
    }
  }

  const content = textParts.join('\n') || msg.text || '';
  if (!content && thoughtParts.length === 0 && toolCalls.length === 0 && toolResults.length === 0) return null;

  const thought = thoughtParts.length ? thoughtParts.join('\n') : undefined;
  const hash = computeMessageHash(role, content, thought, toolCalls.length ? toolCalls : undefined, toolResults.length ? toolResults : undefined);
  return {
    id: msg.uuid ?? createHash('sha256').update(`${threadId}-${sequence}`).digest('hex').slice(0, 16),
    threadId,
    projectId: UNASSIGNED_PROJECT_ID,
    sourceEngine: 'claude-code', // this content came from Claude, delivered via claude.ai web rather than the CLI
    role,
    content,
    thought,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolResults: toolResults.length ? toolResults : undefined,
    timestamp: msg.created_at,
    sequence,
    hash,
    metadata: { imported: true, source: 'claude-export' },
  };
}

/** One-shot bulk import of a claude.ai "Export data" archive's conversations.json — never watched live. */
export function ingestClaudeExport(db: Db, exportDir: string): number {
  const filePath = join(exportDir, 'conversations.json');
  if (!existsSync(filePath)) return 0;

  let conversations: ExportConversation[];
  try {
    conversations = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    db.logIngestEvent({
      engine: 'claude-code',
      filePath,
      eventType: 'full_scan',
      status: 'error',
      message: err?.message,
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  let inserted = 0;
  for (const conv of conversations) {
    const threadId = `claude-export-${conv.uuid}`;
    const existingThread = db.getThread(threadId);
    if (!existingThread) {
      db.upsertThread({
        id: threadId,
        projectId: UNASSIGNED_PROJECT_ID,
        title: `${conv.name} (importé)`.trim() || `Session ${conv.uuid.slice(0, 8)}`,
        originEngine: 'claude-code',
        engineIds: {},
        messageCount: 0,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        status: 'active',
      } as Thread);
    }

    let sequence = 0;
    for (const msg of conv.chat_messages ?? []) {
      const message = toCanonicalMessage(msg, threadId, sequence++);
      if (message && db.insertMessage(message)) inserted++;
    }
    db.upsertThread({
      id: threadId,
      // Bulk imports have no live resolution signal — never clobber a manual triage assignment
      // made via the dashboard on a later re-scan the way a cwd/slug-resolved live thread can.
      projectId: existingThread?.projectId ?? UNASSIGNED_PROJECT_ID,
      title: existingThread?.title ?? (`${conv.name} (importé)`.trim() || `Session ${conv.uuid.slice(0, 8)}`),
      originEngine: 'claude-code',
      engineIds: {},
      messageCount: sequence,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      status: 'active',
    } as Thread);
  }

  db.logIngestEvent({
    engine: 'claude-code',
    filePath,
    eventType: 'full_scan',
    status: 'ok',
    message: `${inserted} nouveau(x) message(s) importé(s) depuis l'export claude.ai`,
    timestamp: new Date().toISOString(),
  });

  return inserted;
}
