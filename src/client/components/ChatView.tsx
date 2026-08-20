import { useEffect, useMemo, useState } from 'react';
import { Brain, Copy, Settings2, Wrench } from 'lucide-react';
import type { EngineType, Message, ToolCall, ToolResult } from '../../types.js';
import { api } from '../lib/api.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

const USER_CARD_COLLAPSE_LENGTH = 600;

function Meta({ sourceEngine, timestamp }: { sourceEngine: EngineType; timestamp: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>{ENGINE_LABEL[sourceEngine] ?? sourceEngine}</span>
      <span>· {new Date(timestamp).toLocaleString('fr-FR')}</span>
    </div>
  );
}

// Some engines log one JSONL event per tool call/result, landing as one Message row each —
// either via the native toolCalls/toolResults fields (verified: none found using this shape live,
// kept for robustness), or — the real, common case verified on Codex data — as a whole message
// whose entire content is one [external_agent_tool_call]/[external_agent_tool_result] text block.
// Consecutive rows like that get grouped into a single "Exécuté N commandes" turn instead of one
// collapsed row each. The embedded-text case reuses MarkdownRenderer's own block consolidation by
// joining the raw content strings — it already collapses a run of these blocks into one summary.
type RenderItem =
  | { kind: 'message'; message: Message }
  | { kind: 'toolGroup'; id: string; sourceEngine: EngineType; timestamp: string; content: string; calls: ToolCall[]; results: ToolResult[] };

function isToolOnlyBlockText(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  return (
    (/^\[external_agent_tool_call:[^\]]*\]/.test(t) && t.endsWith('[/external_agent_tool_call]')) ||
    (/^\[external_agent_tool_result(?::[^\]]*)?\]/.test(t) && t.endsWith('[/external_agent_tool_result]'))
  );
}

function isToolOnly(m: Message): boolean {
  if (m.role === 'user' || m.thought) return false;
  const hasNativeTools = (m.toolCalls?.length ?? 0) + (m.toolResults?.length ?? 0) > 0;
  return hasNativeTools ? !m.content.trim() : isToolOnlyBlockText(m.content);
}

function groupMessages(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  for (const m of messages) {
    const last = items[items.length - 1];
    if (isToolOnly(m)) {
      if (last?.kind === 'toolGroup') {
        last.calls.push(...(m.toolCalls ?? []));
        last.results.push(...(m.toolResults ?? []));
        if (m.content.trim()) last.content += (last.content ? '\n\n' : '') + m.content;
      } else {
        items.push({
          kind: 'toolGroup',
          id: m.id,
          sourceEngine: m.sourceEngine,
          timestamp: m.timestamp,
          content: m.content.trim() ? m.content : '',
          calls: [...(m.toolCalls ?? [])],
          results: [...(m.toolResults ?? [])],
        });
      }
      continue;
    }
    items.push({ kind: 'message', message: m });
  }
  return items;
}

/** The reasoning trail, folded by default. The summary is a verbatim excerpt (first line of the
 * real thought), never a generated description — keeping with sync-hub's verbatim-only rule. */
function ThoughtBlock({ thought }: { thought: string }) {
  const firstLine = thought.split('\n').find((l) => l.trim() !== '')?.trim() ?? 'Réflexion';
  const excerpt = firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
  return (
    <details className="mb-2 rounded-lg border border-accent/25 bg-accent-muted/60 px-2.5 py-1.5 text-xs text-accent-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-1.5">
        <Brain size={13} className="shrink-0" />
        {excerpt}
      </summary>
      <div className="mt-1.5">
        <MarkdownRenderer text={thought} />
      </div>
    </details>
  );
}

/** All tool calls (+ matching results) for a turn collapse into a single "Exécuté N commandes"
 * row, instead of one card per call — many real turns chain a dozen+ calls in a row. */
function ToolCallsBlock({ calls, results }: { calls: ToolCall[]; results?: ToolResult[] }) {
  const resultByCallId = new Map((results ?? []).map((r) => [r.toolCallId, r] as const));
  const orphanResults = (results ?? []).filter((r) => !calls.some((c) => c.id === r.toolCallId));
  const count = calls.length || (results?.length ?? 0);
  const hasError = (results ?? []).some((r) => r.status === 'error');

  const summary =
    count > 1 ? `Exécuté ${count} commandes` : calls[0] ? calls[0].name : `Résultat${hasError ? ' (erreur)' : ''}`;

  return (
    <details className={`mb-2 rounded-lg border px-2.5 py-1.5 text-xs ${hasError ? 'border-destructive/30 bg-destructive-muted/60' : 'border-border bg-muted/60'}`}>
      <summary className={`flex cursor-pointer select-none items-center gap-1.5 ${hasError ? 'text-destructive' : 'text-muted-foreground'}`}>
        {count > 1 ? <Settings2 size={13} className="shrink-0" /> : <Wrench size={13} className="shrink-0" />}
        {summary}
      </summary>
      <div className="mt-1.5 space-y-2">
        {calls.map((call) => {
          const result = resultByCallId.get(call.id);
          return (
            <div key={call.id}>
              <div className="mb-0.5 flex items-center gap-1.5 font-medium text-muted-foreground">
                <Wrench size={11} />
                {call.name}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground/90">{JSON.stringify(call.arguments, null, 2)}</pre>
              {result && (
                <>
                  <div className={`mt-1 mb-0.5 font-medium ${result.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    Résultat{result.status === 'error' ? ' (erreur)' : ''}
                  </div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground/90">{result.output}</pre>
                </>
              )}
            </div>
          );
        })}
        {orphanResults.map((result) => (
          <div key={result.toolCallId}>
            <div className={`mb-0.5 font-medium ${result.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
              Résultat{result.status === 'error' ? ' (erreur)' : ''}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-muted-foreground/90">{result.output}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

/** User turns are the only ones shown as a card — everything the assistant produced (thinking,
 * tool calls, reply) flows directly on the page background instead, per the requested layout. */
function UserCard({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = message.content.length > USER_CARD_COLLAPSE_LENGTH;
  const collapsed = isLong && !expanded;

  return (
    <div>
      <div
        onClick={collapsed ? () => setExpanded(true) : undefined}
        className={`relative rounded-2xl bg-accent-muted px-4 py-3 text-accent-muted-foreground ${collapsed ? 'max-h-40 cursor-pointer overflow-hidden' : ''}`}
      >
        {message.content && <MarkdownRenderer text={message.content} />}
        {collapsed && <div className="absolute inset-x-0 bottom-0 h-10 rounded-b-2xl bg-gradient-to-t from-accent-muted" />}
      </div>
      <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />
    </div>
  );
}

function AssistantTurn({ message }: { message: Message }) {
  return (
    <div>
      <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />
      {message.thought && <ThoughtBlock thought={message.thought} />}
      {(message.toolCalls?.length || message.toolResults?.length) && (
        <ToolCallsBlock calls={message.toolCalls ?? []} results={message.toolResults} />
      )}
      {message.content && <MarkdownRenderer text={message.content} />}
    </div>
  );
}

function RenderedItem({ item }: { item: RenderItem }) {
  if (item.kind === 'toolGroup') {
    return (
      <div>
        <Meta sourceEngine={item.sourceEngine} timestamp={item.timestamp} />
        {(item.calls.length > 0 || item.results.length > 0) && <ToolCallsBlock calls={item.calls} results={item.results} />}
        {item.content && <MarkdownRenderer text={item.content} />}
      </div>
    );
  }
  return item.message.role === 'user' ? <UserCard message={item.message} /> : <AssistantTurn message={item.message} />;
}

export function ChatView({ threadId }: { threadId: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);

  useEffect(() => {
    setMessages(null);
    api.messages(threadId).then(setMessages);
  }, [threadId]);

  const items = useMemo(() => (messages ? groupMessages(messages) : []), [messages]);

  if (!messages) return <div className="p-6 text-sm text-muted-foreground">Chargement…</div>;

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted-foreground" title={threadId}>
          Pour reprendre ce fil ailleurs : demande à l'outil d'appeler <code className="rounded bg-muted px-1">get_thread</code> avec cet id.
        </p>
        <button
          onClick={() => navigator.clipboard.writeText(threadId)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <Copy size={12} />
          Copier l'id du fil
        </button>
      </div>
      <div className="flex flex-col gap-4">
        {messages.length === 0 && <p className="text-sm text-muted-foreground">Aucun message dans ce fil.</p>}
        {items.map((item) => (
          <RenderedItem key={item.kind === 'toolGroup' ? item.id : item.message.id} item={item} />
        ))}
      </div>
    </div>
  );
}
