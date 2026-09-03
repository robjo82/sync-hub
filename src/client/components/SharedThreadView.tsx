import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bot, Brain, Check, ChevronDown, Copy, Globe, Sparkles, User as UserIcon, Wrench } from 'lucide-react';
import type { EngineType, Message, PublicSharedThreadData, ToolCall, ToolResult } from '../../types.js';
import { api } from '../lib/api.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface SharedThreadViewProps {
  shareToken: string;
}

const ENGINE_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cowork: 'Cowork',
  claude: 'Claude.ai',
  chatgpt: 'ChatGPT',
};

const USER_CARD_COLLAPSE_LENGTH = 600;
const ASSISTANT_COLLAPSE_LENGTH = 4000;

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

export function SharedThreadView({ shareToken }: SharedThreadViewProps) {
  const [data, setData] = useState<PublicSharedThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadShare();
  }, [shareToken]);

  async function loadShare() {
    try {
      setLoading(true);
      setError(null);
      const res = await api.publicShare(shareToken);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Ce lien de partage est invalide ou a expiré.');
    } finally {
      setLoading(false);
    }
  }

  function toggleExpanded(id: string) {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function handleCopyContent(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  }

  const items = useMemo(() => (data?.messages ? groupMessages(data.messages) : []), [data?.messages]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent mb-4" />
        <p className="text-sm text-muted-foreground">Chargement de la conversation partagée…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-lg">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive-muted text-destructive">
            <AlertCircle size={24} />
          </div>
          <h1 className="text-base font-semibold text-foreground mb-2">Lien de partage indisponible</h1>
          <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
            {error || 'Cette conversation n’est plus accessible, a été supprimée ou son lien de partage a expiré.'}
          </p>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-opacity"
          >
            Retour à l'accueil
          </a>
        </div>
      </div>
    );
  }

  const { sharedThread, thread, project, messages } = data;
  const totalTokens = messages.reduce((acc, m) => acc + (m.estimatedTokens || 0), 0);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/80 backdrop-blur-md px-4 py-4 sm:px-10">
        <div className="mx-auto max-w-4xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent-muted-foreground shadow-xs">
              <Sparkles size={18} className="text-accent" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm tracking-tight text-foreground">Sync Hub</span>
                <span className="inline-flex items-center rounded-full bg-accent-muted px-2 py-2 text-sm font-medium text-accent-muted-foreground">
                  Lecture seule
                </span>
              </div>
              <p className="text-sm text-muted-foreground truncate">
                {project ? project.name : 'Conversation partagée'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="hidden sm:inline-flex items-center gap-2">
              <Globe size={13} /> Lien public
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-10 space-y-6">
        {/* Thread Info Banner */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
          <h1 className="text-xl sm:text-xl font-semibold text-foreground mb-2 leading-snug">
            {sharedThread.title || thread.title}
          </h1>

          <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center rounded-xl bg-muted px-2 py-2 font-medium text-foreground">
              {ENGINE_LABEL[thread.originEngine] ?? thread.originEngine}
            </span>
            <span>· {messages.length} messages</span>
            {totalTokens > 0 && <span>· ~{totalTokens.toLocaleString('fr-FR')} tokens</span>}
            <span>· Créé le {new Date(thread.createdAt).toLocaleDateString('fr-FR')}</span>
          </div>
        </div>

        {/* Messages List */}
        <div className="space-y-4">
          {items.map((item) => {
            if (item.kind === 'toolGroup') {
              const isExpanded = !!expandedItems[item.id];
              const totalCalls = item.calls.length || 1;
              return (
                <div key={item.id} className="rounded-xl border border-border bg-muted/30 overflow-hidden text-sm">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(item.id)}
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Wrench size={13} className="text-accent" />
                      <span className="font-medium text-foreground">
                        {totalCalls > 1 ? `Exécution de ${totalCalls} outils` : 'Appel d’outil'}
                      </span>
                      <span>· {new Date(item.timestamp).toLocaleTimeString('fr-FR')}</span>
                    </div>
                    <ChevronDown size={14} className={isExpanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border p-4 bg-muted/20 space-y-2 font-mono text-sm">
                      {item.content && <MarkdownRenderer text={item.content} />}
                    </div>
                  )}
                </div>
              );
            }

            const m = item.message;
            const isUser = m.role === 'user';
            const isExpanded = !!expandedItems[m.id];
            const shouldCollapse = isUser
              ? m.content.length > USER_CARD_COLLAPSE_LENGTH
              : m.content.length > ASSISTANT_COLLAPSE_LENGTH;
            const displayContent = shouldCollapse && !isExpanded
              ? m.content.slice(0, isUser ? USER_CARD_COLLAPSE_LENGTH : ASSISTANT_COLLAPSE_LENGTH) + '…'
              : m.content;

            return (
              <div
                key={m.id}
                className={`rounded-xl border p-4 sm:p-6 transition-colors ${
                  isUser
                    ? 'border-accent-muted bg-accent-muted/30 text-foreground'
                    : 'border-border bg-card text-foreground shadow-xs'
                }`}
              >
                {/* Message Header */}
                <div className="flex items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-2">
                    <div
                      className={`flex h-6 w-6 items-center justify-center rounded-xl text-sm font-semibold ${
                        isUser ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground'
                      }`}
                    >
                      {isUser ? <UserIcon size={13} /> : <Bot size={13} />}
                    </div>
                    <span className="font-semibold text-sm text-foreground">
                      {isUser ? 'Utilisateur' : ENGINE_LABEL[m.sourceEngine] ?? m.sourceEngine}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      · {new Date(m.timestamp).toLocaleTimeString('fr-FR')}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyContent(m.id, m.content)}
                    className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                    title="Copier le message"
                  >
                    {copiedId === m.id ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    <span>{copiedId === m.id ? 'Copié' : 'Copier'}</span>
                  </button>
                </div>

                {/* Reasoning / Thought block */}
                {m.thought && (
                  <div className="mb-4 rounded-xl border border-border bg-muted/40 p-4 text-sm">
                    <div className="flex items-center gap-2 font-medium text-muted-foreground mb-2">
                      <Brain size={13} />
                      <span>Raisonnement de l'IA</span>
                    </div>
                    <div className="text-muted-foreground text-sm leading-relaxed italic">
                      <MarkdownRenderer text={m.thought} />
                    </div>
                  </div>
                )}

                {/* Main Content */}
                <div className="text-sm leading-relaxed overflow-hidden">
                  <MarkdownRenderer text={displayContent} />
                </div>

                {/* Collapse button */}
                {shouldCollapse && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(m.id)}
                    className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline cursor-pointer"
                  >
                    {isExpanded ? 'Afficher moins' : 'Afficher l’intégralité du message'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-card py-6 text-center text-sm text-muted-foreground">
        <p>Partagé via <strong className="font-medium text-foreground">Sync Hub</strong> · Centralisation des historiques IA</p>
      </footer>
    </div>
  );
}
