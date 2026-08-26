import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Hash, Search } from 'lucide-react';
import type { Message, Thread } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

interface SearchResult {
  message: Message;
  projectName: string;
  threadTitle: string;
}

/** Mirrors the server's word-by-word matching (db.ts searchTranscripts) closely enough for
 * highlighting purposes — doesn't need byte-identical stopword filtering, just something that
 * finds the same words a user would recognize as "what I searched for". */
function queryWords(query: string): string[] {
  return Array.from(new Set(query.trim().split(/\s+/).filter((w) => w.length >= 2).map((w) => w.toLowerCase())));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wraps every occurrence of any query word in <mark>, case-insensitively, preserving original casing. */
function highlight(text: string, words: string[]): ReactNode {
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  const lowerWords = new Set(words);
  return parts.map((part, i) =>
    lowerWords.has(part.toLowerCase()) ? (
      <mark key={i} className="rounded bg-accent/30 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/**
 * Finds the ~200-char window of `content` that covers the most distinct query words — not just
 * the first match — since the server matches words independently, in any order and not
 * necessarily contiguous (see db.ts searchTranscripts), so anchoring on the full query as one
 * exact phrase (the old approach) missed the actual matched words entirely and fell back to
 * showing the first 200 characters regardless of relevance.
 */
function bestWindow(content: string, words: string[], windowSize = 200): { start: number; end: number } | null {
  if (words.length === 0) return null;
  const lower = content.toLowerCase();
  const matches: { pos: number; word: string }[] = [];
  for (const word of words) {
    let idx = lower.indexOf(word);
    while (idx !== -1) {
      matches.push({ pos: idx, word });
      idx = lower.indexOf(word, idx + 1);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.pos - b.pos);

  const counts = new Map<string, number>();
  let distinct = 0;
  let left = 0;
  let bestStart = matches[0].pos;
  let bestDistinct = 0;
  for (let right = 0; right < matches.length; right++) {
    const w = matches[right].word;
    counts.set(w, (counts.get(w) ?? 0) + 1);
    if (counts.get(w) === 1) distinct++;
    while (matches[right].pos - matches[left].pos > windowSize) {
      const lw = matches[left].word;
      const next = counts.get(lw)! - 1;
      counts.set(lw, next);
      if (next === 0) distinct--;
      left++;
    }
    if (distinct > bestDistinct) {
      bestDistinct = distinct;
      bestStart = matches[left].pos;
    }
  }
  return { start: bestStart, end: bestStart + windowSize };
}

/** Returns the snippet text and whether any query word was actually found in this message's
 * content — false means this result was surfaced via a thread-title match instead (see
 * db.ts searchTranscripts), so the content snippet here is unrelated and shouldn't be shown as if
 * it were the reason for the match. */
function snippet(content: string, query: string): { text: string; matchedContent: boolean } {
  const words = queryWords(query);
  const window = bestWindow(content, words);
  if (!window) return { text: content.length > 200 ? `${content.slice(0, 200)}…` : content, matchedContent: false };
  const start = Math.max(0, window.start - 60);
  const end = Math.min(content.length, window.end + 60);
  const text = `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
  return { text, matchedContent: true };
}

/** No point querying on every keystroke — this is how fast someone can realistically type, not
 * how fast the FTS5 query itself runs. Cuts request volume roughly 5-10x on a real query typed at
 * normal speed, and (with the request-sequencing below) removes the flicker of a slow early
 * response overwriting a faster later one. */
const SEARCH_DEBOUNCE_MS = 250;

export function SearchView({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [idMatch, setIdMatch] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(false);
  // Every debounced search gets a ticket; only the most recently issued one is allowed to commit
  // its results — otherwise an earlier, slower request resolving after a later, faster one would
  // silently overwrite what's on screen with stale results (a real race, not hypothetical: it's
  // exactly what unthrottled per-keystroke requests used to do).
  const latestRequestId = useRef(0);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setIdMatch(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const requestId = ++latestRequestId.current;
    const timer = setTimeout(async () => {
      try {
        const [textResults, thread] = await Promise.all([
          api.search(query),
          // A thread id is an opaque string from whichever engine produced it (Claude Code/Codex
          // UUID, a ChatGPT template id, a content hash…) — no fixed shape to pattern-match, so
          // just try the direct lookup alongside the text search rather than guessing what an id
          // looks like. A 404 here is the expected, common case (most queries aren't an id).
          api.thread(query.trim()).catch(() => null),
        ]);
        if (requestId !== latestRequestId.current) return; // superseded by a newer keystroke
        setResults(textResults);
        setIdMatch(thread);
      } finally {
        if (requestId === latestRequestId.current) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Recherche</h2>
      <p className="mb-4 text-xs text-muted-foreground">Recherche verbatim (sous-chaîne) dans tous les messages, tous projets et outils confondus.</p>

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
              <span className="font-medium">{highlight(idMatch.title, queryWords(query))}</span> — trouvé directement par id
            </span>
            <span className="shrink-0 text-xs text-accent-muted-foreground/70">{ENGINE_LABEL[idMatch.originEngine] ?? idMatch.originEngine}</span>
          </button>
        )}
        {!loading && results && results.length === 0 && !idMatch && <p className="text-sm text-muted-foreground">Aucun résultat.</p>}
        {!loading &&
          results?.map((r) => {
            const words = queryWords(query);
            const { text, matchedContent } = snippet(r.message.content, query);
            return (
              <button
                key={r.message.id}
                onClick={() => onOpenThread(r.message.threadId)}
                className="block w-full rounded-lg border border-border bg-card p-3 text-left hover:border-accent/40"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.projectName}</span>
                  <span>·</span>
                  <span className="truncate">{highlight(r.threadTitle, words)}</span>
                  <span>·</span>
                  <span>{ENGINE_LABEL[r.message.sourceEngine] ?? r.message.sourceEngine}</span>
                  <span className="ml-auto shrink-0">{new Date(r.message.timestamp).toLocaleDateString('fr-FR')}</span>
                </div>
                {!matchedContent && (
                  <p className="mb-1 text-xs text-muted-foreground/70 italic">trouvé via le titre du fil</p>
                )}
                <p className="text-sm text-foreground">{highlight(text, words)}</p>
              </button>
            );
          })}
      </div>
    </div>
  );
}
