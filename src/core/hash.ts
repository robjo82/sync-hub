import { createHash } from 'node:crypto';
import type { MessageRole, ToolCall, ToolResult } from '../types.js';

/**
 * The single anti-duplicate-ingestion key, shared by every adapter (enforced as messages.hash
 * UNIQUE). Must include `thought` — a reasoning-only turn (Codex's `reasoning` summaries,
 * ChatGPT's `thoughts` nodes, Claude's thinking-only blocks) has role+content identical to every
 * other reasoning-only turn in the same thread (content is empty), so without the thought text
 * itself in the hash, two genuinely different reasoning messages collide and the second is
 * silently dropped as a false duplicate.
 */
export function computeMessageHash(
  role: MessageRole,
  content: string,
  thought?: string,
  toolCalls?: ToolCall[],
  toolResults?: ToolResult[],
): string {
  const payload = JSON.stringify({
    role,
    content,
    thought,
    toolCalls: toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })),
    toolResults: toolResults?.map((r) => ({ name: r.name, output: r.output.slice(0, 500) })),
  });
  return createHash('sha256').update(payload).digest('hex');
}
