import { useState } from 'react';
import type { Message } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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
  const [loading, setLoading] = useState(false);

  const runSearch = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      setResults(await api.search(q));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Recherche</h2>
      <p className="mb-4 text-xs text-slate-500">Recherche verbatim (sous-chaîne) dans tous les messages, tous projets et outils confondus.</p>

      <input
        autoFocus
        value={query}
        onChange={(e) => runSearch(e.target.value)}
        placeholder="Rechercher…"
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-600"
      />

      <div className="mt-4 space-y-2">
        {loading && <p className="text-sm text-slate-500">Recherche…</p>}
        {!loading && results && results.length === 0 && <p className="text-sm text-slate-500">Aucun résultat.</p>}
        {!loading &&
          results?.map((r) => (
            <button
              key={r.message.id}
              onClick={() => onOpenThread(r.message.threadId)}
              className="block w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700 dark:text-slate-300">{r.projectName}</span>
                <span>·</span>
                <span className="truncate">{r.threadTitle}</span>
                <span>·</span>
                <span>{ENGINE_LABEL[r.message.sourceEngine] ?? r.message.sourceEngine}</span>
                <span className="ml-auto shrink-0">{new Date(r.message.timestamp).toLocaleDateString('fr-FR')}</span>
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-300">{snippet(r.message.content, query)}</p>
            </button>
          ))}
      </div>
    </div>
  );
}
