import { useEffect, useMemo, useState } from 'react';
import { Archive, Brain, Check, Copy, FolderInput, Info, Settings2, Trash2, Wrench, X } from 'lucide-react';
import type { EngineType, Message, Project, Thread, ToolCall, ToolResult } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api } from '../lib/api.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

const USER_CARD_COLLAPSE_LENGTH = 600;

function Meta({ sourceEngine, timestamp, className = 'mb-1' }: { sourceEngine: EngineType; timestamp: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className}`}>
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
  | {
      kind: 'toolGroup';
      id: string;
      sourceEngine: EngineType;
      timestamp: string;
      endTimestamp: string;
      content: string;
      calls: ToolCall[];
      results: ToolResult[];
    };

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
        last.endTimestamp = m.timestamp;
      } else {
        items.push({
          kind: 'toolGroup',
          id: m.id,
          sourceEngine: m.sourceEngine,
          timestamp: m.timestamp,
          endTimestamp: m.timestamp,
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

/** Elapsed time between two real recorded timestamps, formatted for the reasoning block's summary
 * line — never a generated/estimated value, just an actual gap between two real events. Omitted
 * (returns null) when it's too short to be meaningful or too long to plausibly reflect one
 * continuous reasoning span (a real pause elsewhere in the thread, not "thinking time"). */
function formatDuration(fromIso: string, toIso: string): string | null {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 1000 || ms > 30 * 60 * 1000) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** The reasoning trail AND the tool calls it led to, folded together under one summary line
 * instead of two separate cards — one click reveals both. The summary is a verbatim excerpt (first
 * line of the real thought) when there's a thought, or the tool-call summary otherwise — never a
 * generated description, keeping with sync-hub's verbatim-only rule. */
function ReasoningBlock({
  thought,
  calls,
  results,
  durationLabel,
}: {
  thought?: string;
  calls: ToolCall[];
  results?: ToolResult[];
  durationLabel: string | null;
}) {
  const firstLine = thought?.split('\n').find((l) => l.trim() !== '')?.trim();
  const excerpt = firstLine ? (firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine) : null;
  const summary = excerpt ?? (durationLabel ? `Réflexion (${durationLabel})` : 'Réflexion');

  return (
    <details className="mb-2 rounded-lg border border-accent/25 bg-accent-muted/60 px-2.5 py-1.5 text-xs text-accent-muted-foreground">
      <summary className="flex cursor-pointer select-none items-center gap-1.5">
        <Brain size={13} className="shrink-0" />
        {summary}
        {excerpt && durationLabel && <span className="text-accent-muted-foreground/70">· {durationLabel}</span>}
      </summary>
      <div className="mt-1.5 space-y-2">
        {thought && <MarkdownRenderer text={thought} />}
        {(calls.length > 0 || (results?.length ?? 0) > 0) && <ToolCallsBlock calls={calls} results={results} />}
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
      <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} className="mt-1.5" />
    </div>
  );
}

/** A system-role notice (e.g. Antigravity's <SYSTEM_MESSAGE> wrapper, or a background-task
 * notification) — real content, but injected rather than typed by anyone, so it's folded by
 * default like the reasoning trail rather than shown inline at full height. */
function SystemNoticeBlock({ message }: { message: Message }) {
  return (
    <div>
      <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />
      <details className="rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer select-none items-center gap-1.5">
          <Info size={13} className="shrink-0" />
          Message système
        </summary>
        <div className="mt-1.5">
          <MarkdownRenderer text={message.content} />
        </div>
      </details>
    </div>
  );
}

function AssistantTurn({ message, previousTimestamp }: { message: Message; previousTimestamp?: string }) {
  const hasReasoning = !!message.thought || (message.toolCalls?.length ?? 0) > 0 || (message.toolResults?.length ?? 0) > 0;
  const durationLabel = previousTimestamp ? formatDuration(previousTimestamp, message.timestamp) : null;
  return (
    <div>
      <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />
      {hasReasoning && (
        <ReasoningBlock thought={message.thought} calls={message.toolCalls ?? []} results={message.toolResults} durationLabel={durationLabel} />
      )}
      {message.content && <MarkdownRenderer text={message.content} />}
    </div>
  );
}

function RenderedItem({ item, previousTimestamp }: { item: RenderItem; previousTimestamp?: string }) {
  if (item.kind === 'toolGroup') {
    const hasReasoning = item.calls.length > 0 || item.results.length > 0;
    const durationLabel = formatDuration(item.timestamp, item.endTimestamp) ?? (previousTimestamp ? formatDuration(previousTimestamp, item.timestamp) : null);
    return (
      <div>
        <Meta sourceEngine={item.sourceEngine} timestamp={item.timestamp} />
        {hasReasoning && <ReasoningBlock calls={item.calls} results={item.results} durationLabel={durationLabel} />}
        {item.content && <MarkdownRenderer text={item.content} />}
      </div>
    );
  }
  if (item.message.role === 'user') return <UserCard message={item.message} />;
  if (item.message.role === 'system') return <SystemNoticeBlock message={item.message} />;
  return <AssistantTurn message={item.message} previousTimestamp={previousTimestamp} />;
}

function itemTimestamp(item: RenderItem): string {
  return item.kind === 'toolGroup' ? item.endTimestamp : item.message.timestamp;
}

const actionButtonClass = 'flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted';

/** Assign-to-project control, only rendered when the thread has never been classified — the
 * dashboard's "Non affecté" triage action, available directly from the thread itself too. */
function AssignControl({ allProjects, onAssign }: { allProjects: Project[]; onAssign: (projectId: string) => void }) {
  const [target, setTarget] = useState('');
  return (
    <div className="flex shrink-0 items-center gap-1">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground"
      >
        <option value="">Classer dans…</option>
        {allProjects
          .filter((p) => p.id !== UNASSIGNED_PROJECT_ID)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
      <button onClick={() => target && onAssign(target)} disabled={!target} className={`${actionButtonClass} disabled:opacity-40`}>
        <FolderInput size={12} />
        OK
      </button>
    </div>
  );
}

function ArchiveButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        Archiver ce fil ?
        <button onClick={onConfirm} className="rounded p-1 text-warning hover:bg-warning-muted">
          <Check size={14} />
        </button>
        <button onClick={() => setConfirming(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X size={14} />
        </button>
      </span>
    );
  }
  return (
    <button onClick={() => setConfirming(true)} className={actionButtonClass}>
      <Archive size={12} />
      Archiver
    </button>
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        Supprimer ce fil de sync-hub ?
        <button onClick={onConfirm} className="rounded p-1 text-destructive hover:bg-destructive-muted">
          <Check size={14} />
        </button>
        <button onClick={() => setConfirming(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X size={14} />
        </button>
      </span>
    );
  }
  return (
    <button onClick={() => setConfirming(true)} className={actionButtonClass}>
      <Trash2 size={12} />
      Supprimer
    </button>
  );
}

export function ChatView({
  threadId,
  allProjects,
  onChanged,
  onDeleted,
}: {
  threadId: string;
  allProjects: Project[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);

  useEffect(() => {
    setMessages(null);
    setThread(null);
    api.messages(threadId).then(setMessages);
    api.thread(threadId).then(setThread);
  }, [threadId]);

  const items = useMemo(() => (messages ? groupMessages(messages) : []), [messages]);

  if (!messages) return <div className="p-6 text-sm text-muted-foreground">Chargement…</div>;

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" title={threadId}>
          Pour reprendre ce fil ailleurs : demande à l'outil d'appeler <code className="rounded bg-muted px-1">get_thread</code> avec cet id.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {thread?.projectId === UNASSIGNED_PROJECT_ID && (
            <AssignControl
              allProjects={allProjects}
              onAssign={async (projectId) => {
                await api.assignThread(threadId, projectId);
                setThread((t) => (t ? { ...t, projectId } : t));
                onChanged();
              }}
            />
          )}
          <ArchiveButton
            onConfirm={async () => {
              await api.archiveThread(threadId);
              onChanged();
              onDeleted();
            }}
          />
          <DeleteButton
            onConfirm={async () => {
              await api.deleteThread(threadId);
              onChanged();
              onDeleted();
            }}
          />
          <button onClick={() => navigator.clipboard.writeText(threadId)} className={actionButtonClass}>
            <Copy size={12} />
            Copier l'id du fil
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {messages.length === 0 && <p className="text-sm text-muted-foreground">Aucun message dans ce fil.</p>}
        {items.map((item, idx) => (
          <RenderedItem
            key={item.kind === 'toolGroup' ? item.id : item.message.id}
            item={item}
            previousTimestamp={idx > 0 ? itemTimestamp(items[idx - 1]) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
