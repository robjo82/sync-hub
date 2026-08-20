import { useState } from 'react';
import { Hash, Search } from 'lucide-react';
import type { Message, Thread } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

interface SearchResult {
  message: Message;
  projectName: string;
  threadTitle: string;
}

function snippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, 200);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + query.length + 80);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

export function SearchView({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [idMatch, setIdMatch] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(false);

  const runSearch = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults(null);
      setIdMatch(null);
      return;
    }
    setLoading(true);
    try {
      const [textResults, thread] = await Promise.all([
        api.search(q),
        // A thread id is an opaque string from whichever engine produced it (Claude Code/Codex
        // UUID, a ChatGPT template id, a content hash…) — no fixed shape to pattern-match, so
        // just try the direct lookup alongside the text search rather than guessing what an id
        // looks like. A 404 here is the expected, common case (most queries aren't an id).
        api.thread(q.trim()).catch(() => null),
      ]);
      setResults(textResults);
      setIdMatch(thread);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Recherche</h2>
      <p className="mb-4 text-xs text-muted-foreground">Recherche verbatim (sous-chaîne) dans tous les messages, tous projets et outils confondus.</p>

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          placeholder="Rechercher…"
          className="w-full rounded-md border border-border bg-card py-2 pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </div>

      <div className="mt-4 space-y-2">
        {loading && <p className="text-sm text-muted-foreground">Recherche…</p>}
        {!loading && idMatch && (
          <button
            onClick={() => onOpenThread(idMatch.id)}
            className="flex w-full items-center gap-2 rounded-lg border border-accent/40 bg-accent-muted p-3 text-left hover:border-accent"
          >
            <Hash size={14} className="shrink-0 text-accent" />
            <span className="flex-1 truncate text-sm text-accent-muted-foreground">
              <span className="font-medium">{idMatch.title}</span> — trouvé directement par id
            </span>
            <span className="shrink-0 text-xs text-accent-muted-foreground/70">{ENGINE_LABEL[idMatch.originEngine] ?? idMatch.originEngine}</span>
          </button>
        )}
        {!loading && results && results.length === 0 && !idMatch && <p className="text-sm text-muted-foreground">Aucun résultat.</p>}
        {!loading &&
          results?.map((r) => (
            <button
              key={r.message.id}
              onClick={() => onOpenThread(r.message.threadId)}
              className="block w-full rounded-lg border border-border bg-card p-3 text-left hover:border-accent/40"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{r.projectName}</span>
                <span>·</span>
                <span className="truncate">{r.threadTitle}</span>
                <span>·</span>
                <span>{ENGINE_LABEL[r.message.sourceEngine] ?? r.message.sourceEngine}</span>
                <span className="ml-auto shrink-0">{new Date(r.message.timestamp).toLocaleDateString('fr-FR')}</span>
              </div>
              <p className="text-sm text-foreground">{snippet(r.message.content, query)}</p>
            </button>
          ))}
      </div>
    </div>
  );
}
