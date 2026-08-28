import { useEffect, useMemo, useState } from 'react';
import { Archive, Brain, Check, ChevronDown, Copy, FolderInput, Info, List, Settings2, Share2, Trash2, Wrench, X } from 'lucide-react';
import type { EngineType, Message, Project, Thread, ToolCall, ToolResult } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api, type ThreadOutlineEntry } from '../lib/api.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ShareModal } from './ShareModal.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

const USER_CARD_COLLAPSE_LENGTH = 600;
const ASSISTANT_COLLAPSE_LENGTH = 4000;
/** Below this, consecutive turns from the same engine are one continuous stretch of work and
 * repeating "Claude Code · 16:52:34" above each one is noise, not information. */
const META_REPEAT_GAP_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;

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
function SystemNoticeBlock({ message, showMeta }: { message: Message; showMeta: boolean }) {
  return (
    <div>
      {showMeta && <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />}
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

function AssistantTurn({
  message,
  previousTimestamp,
  showMeta,
}: {
  message: Message;
  previousTimestamp?: string;
  showMeta: boolean;
}) {
  const hasReasoning = !!message.thought || (message.toolCalls?.length ?? 0) > 0 || (message.toolResults?.length ?? 0) > 0;
  const durationLabel = previousTimestamp ? formatDuration(previousTimestamp, message.timestamp) : null;
  return (
    <div>
      {showMeta && <Meta sourceEngine={message.sourceEngine} timestamp={message.timestamp} />}
      {hasReasoning && (
        <ReasoningBlock thought={message.thought} calls={message.toolCalls ?? []} results={message.toolResults} durationLabel={durationLabel} />
      )}
      {message.content && <CollapsibleContent text={message.content} />}
    </div>
  );
}

/** A single assistant turn can be enormous — the largest one in this store is 355k characters,
 * which on its own makes a thread unscrollable. Long ones open to a readable height with the rest
 * one click away; nothing is truncated or rewritten, only hidden. */
function CollapsibleContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= ASSISTANT_COLLAPSE_LENGTH) return <MarkdownRenderer text={text} />;
  return (
    <div>
      <div className={`relative ${expanded ? '' : 'max-h-96 overflow-hidden'}`}>
        <MarkdownRenderer text={text} />
        {!expanded && <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background" />}
      </div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {expanded ? 'Replier ce message' : `Afficher la suite (${Math.round(text.length / 1000)} k caractères)`}
      </button>
    </div>
  );
}

function RenderedItem({
  item,
  previousTimestamp,
  showMeta,
}: {
  item: RenderItem;
  previousTimestamp?: string;
  showMeta: boolean;
}) {
  if (item.kind === 'toolGroup') {
    const hasReasoning = item.calls.length > 0 || item.results.length > 0;
    const durationLabel = formatDuration(item.timestamp, item.endTimestamp) ?? (previousTimestamp ? formatDuration(previousTimestamp, item.timestamp) : null);
    return (
      <div>
        {showMeta && <Meta sourceEngine={item.sourceEngine} timestamp={item.timestamp} />}
        {hasReasoning && <ReasoningBlock calls={item.calls} results={item.results} durationLabel={durationLabel} />}
        {item.content && <CollapsibleContent text={item.content} />}
      </div>
    );
  }
  if (item.message.role === 'user') return <UserCard message={item.message} />;
  if (item.message.role === 'system') return <SystemNoticeBlock message={item.message} showMeta={showMeta} />;
  return <AssistantTurn message={item.message} previousTimestamp={previousTimestamp} showMeta={showMeta} />;
}

function itemTimestamp(item: RenderItem): string {
  return item.kind === 'toolGroup' ? item.endTimestamp : item.message.timestamp;
}

function itemEngine(item: RenderItem): EngineType {
  return item.kind === 'toolGroup' ? item.sourceEngine : item.message.sourceEngine;
}

function isUserItem(item: RenderItem): boolean {
  return item.kind === 'message' && item.message.role === 'user';
}

/** Whether this item still needs its own "engine · timestamp" line. Repeating it above every
 * consecutive assistant turn is what makes a thread read as a wall of stamps; it earns its place
 * when the turn actually starts something — the first item, a reply to the user, a switch of
 * engine, or a real pause. */
function shouldShowMeta(item: RenderItem, previous: RenderItem | undefined): boolean {
  if (!previous) return true;
  if (isUserItem(item)) return true;
  if (isUserItem(previous)) return true;
  if (itemEngine(item) !== itemEngine(previous)) return true;
  const gap = new Date(itemTimestamp(item)).getTime() - new Date(itemTimestamp(previous)).getTime();
  return !Number.isFinite(gap) || gap > META_REPEAT_GAP_MS;
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
  const [idCopied, setIdCopied] = useState(false);
  const [total, setTotal] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [outline, setOutline] = useState<ThreadOutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  useEffect(() => {
    setMessages(null);
    setThread(null);
    setOutline([]);
    setOutlineOpen(false);
    setWindowStart(0);
    let cancelled = false;
    api.messages(threadId, { offset: 0, limit: PAGE_SIZE }).then((r) => {
      if (cancelled) return;
      setMessages(r.messages);
      setTotal(r.total);
    });
    api.thread(threadId).then((t) => !cancelled && setThread(t));
    api.threadOutline(threadId).then((o) => !cancelled && setOutline(o));
    // A thread switch while a page is still in flight would otherwise paint the previous thread's
    // messages over the new one.
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const loadedEnd = windowStart + (messages?.length ?? 0);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await api.messages(threadId, { offset: loadedEnd, limit: PAGE_SIZE });
      setMessages((prev) => [...(prev ?? []), ...r.messages]);
      setTotal(r.total);
    } finally {
      setLoadingMore(false);
    }
  }

  /** Jumping replaces the window rather than paging forward to reach the target: reaching message
   * 12 000 by appending 100 at a time would be 120 requests and 12 000 mounted nodes. */
  async function jumpTo(position: number) {
    setMessages(null);
    setOutlineOpen(false);
    const r = await api.messages(threadId, { offset: position, limit: PAGE_SIZE });
    setWindowStart(position);
    setMessages(r.messages);
    setTotal(r.total);
    document.getElementById('thread-top')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  useEffect(() => {
    if (!idCopied) return;
    const timer = setTimeout(() => setIdCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [idCopied]);

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
          <button
            onClick={() => setShareModalOpen(true)}
            className={actionButtonClass}
            title="Partager cette conversation"
          >
            <Share2 size={12} />
            Partager
          </button>
          <button
            onClick={async () => {
              // Clipboard writes can fail silently (permission denied, insecure context) — only
              // claim success once the browser actually confirms it, rather than assuming it worked.
              try {
                await navigator.clipboard.writeText(threadId);
                setIdCopied(true);
              } catch {
                // no feedback shown — a false "copied" would be worse than none
              }
            }}
            className={actionButtonClass}
          >
            {idCopied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {idCopied ? 'Copié' : "Copier l'id du fil"}
          </button>
        </div>
      </div>
      {outline.length > 1 && (
        <div className="mb-3">
          <button
            onClick={() => setOutlineOpen((o) => !o)}
            className={`${actionButtonClass} w-full justify-between`}
          >
            <span className="flex items-center gap-1.5">
              <List size={12} />
              Sommaire du fil — {outline.length} questions
            </span>
            <ChevronDown size={12} className={outlineOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {outlineOpen && (
            <ol className="mt-1.5 max-h-72 overflow-y-auto rounded-md border border-border">
              {outline.map((entry, i) => {
                const loaded = entry.position >= windowStart && entry.position < loadedEnd;
                return (
                  <li key={entry.id}>
                    <button
                      onClick={() =>
                        loaded
                          ? document.getElementById(`msg-${entry.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          : jumpTo(entry.position)
                      }
                      className="flex w-full items-baseline gap-2 border-b border-border/60 px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
                      <span className="truncate text-foreground">{entry.excerpt || '(message vide)'}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {windowStart > 0 && (
        <p className="mb-3 text-center text-xs text-muted-foreground">
          Affichage à partir du message {windowStart + 1}.{' '}
          <button onClick={() => jumpTo(0)} className="underline underline-offset-2 hover:text-foreground">
            Revenir au début du fil
          </button>
        </p>
      )}

      <div id="thread-top" className="flex flex-col gap-4">
        {messages.length === 0 && <p className="text-sm text-muted-foreground">Aucun message dans ce fil.</p>}
        {items.map((item, idx) => (
          <div key={item.kind === 'toolGroup' ? item.id : item.message.id} id={item.kind === 'message' ? `msg-${item.message.id}` : undefined}>
            <RenderedItem
              item={item}
              previousTimestamp={idx > 0 ? itemTimestamp(items[idx - 1]) : undefined}
              showMeta={shouldShowMeta(item, idx > 0 ? items[idx - 1] : undefined)}
            />
          </div>
        ))}
      </div>

      {loadedEnd < total && (
        <div className="mt-4 flex flex-col items-center gap-1">
          <button onClick={loadMore} disabled={loadingMore} className={`${actionButtonClass} disabled:opacity-50`}>
            {loadingMore ? 'Chargement…' : `Charger la suite (${total - loadedEnd} messages restants)`}
          </button>
          <span className="text-xs text-muted-foreground">
            {loadedEnd} / {total} affichés
          </span>
        </div>
      )}

      {shareModalOpen && thread && (
        <ShareModal thread={thread} onClose={() => setShareModalOpen(false)} />
      )}
    </div>
  );
}
