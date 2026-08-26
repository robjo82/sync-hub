import { useEffect, useState } from 'react';
import type { Project, Thread } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

function ThreadRow({ thread, projects, onAssigned }: { thread: Thread; projects: Project[]; onAssigned: () => void }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const assign = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.assignThread(thread.id, target);
      onAssigned();
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 text-foreground">{thread.title}</td>
      <td className="px-3 py-2 text-muted-foreground">{ENGINE_LABEL[thread.originEngine] ?? thread.originEngine}</td>
      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground/70" title={thread.sourceRef}>
        {thread.sourceRef ?? '—'}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{thread.messageCount}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
          >
            <option value="">Assigner à…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={assign}
            disabled={!target || busy}
            className="rounded border border-accent/30 bg-accent-muted px-2 py-1 text-xs text-accent disabled:opacity-40"
          >
            {busy ? '…' : 'OK'}
          </button>
        </div>
      </td>
    </tr>
  );
}

const PAGE_SIZE = 50;

export function UnassignedView({ projects }: { projects: Project[] }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [filter, setFilter] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const load = () => api.threads(UNASSIGNED_PROJECT_ID).then(setThreads);
  useEffect(() => {
    load();
  }, []);

  // Reset how many rows are shown whenever the filter changes, so narrowing the list doesn't
  // leave "load more" stuck past the end of a now-much-shorter result set.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter]);

  const knownProjects = projects.filter((p) => p.id !== UNASSIGNED_PROJECT_ID);

  const needle = filter.trim().toLowerCase();
  const filtered = !threads
    ? []
    : needle
      ? threads.filter((t) => t.title.toLowerCase().includes(needle) || (t.sourceRef ?? '').toLowerCase().includes(needle))
      : threads;
  // Rendering all ~4600 real unassigned rows at once (each with a <select> full of ~40 projects)
  // was a real, measured source of UI lag — only the visible page's worth of rows ever mounts.
  const visible = filtered.slice(0, visibleCount);

  return (
    <div className="mx-auto max-w-4xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Non affecté</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Sessions dont le dossier de travail ne correspond à aucun projet connu (dossiers fantômes générés par les outils, sessions
        lancées à la racine du home…). Assigne-les manuellement — sync-hub retiendra la correspondance pour la prochaine fois.
      </p>

      {!threads ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">Rien à trier pour l'instant.</p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrer par titre ou source…"
              className="w-72 rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
            />
            <span className="shrink-0 text-xs text-muted-foreground">
              {filtered.length === threads.length ? `${threads.length} fils` : `${filtered.length} / ${threads.length} fils`}
            </span>
          </div>

          <table className="w-full border-collapse overflow-hidden rounded-lg border border-border text-sm">
            <thead>
              <tr className="bg-muted text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Fil</th>
                <th className="px-3 py-2 font-medium">Outil</th>
                <th className="px-3 py-2 font-medium">Source (cwd / slug)</th>
                <th className="px-3 py-2 font-medium">Messages</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <ThreadRow key={t.id} thread={t} projects={knownProjects} onAssigned={load} />
              ))}
            </tbody>
          </table>

          {visibleCount < filtered.length && (
            <button
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="mt-3 w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Afficher {Math.min(PAGE_SIZE, filtered.length - visibleCount)} de plus ({filtered.length - visibleCount} restants)
            </button>
          )}
        </>
      )}
    </div>
  );
}
