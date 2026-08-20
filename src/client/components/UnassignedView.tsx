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

export function UnassignedView({ projects }: { projects: Project[] }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);

  const load = () => api.threads(UNASSIGNED_PROJECT_ID).then(setThreads);
  useEffect(() => {
    load();
  }, []);

  const knownProjects = projects.filter((p) => p.id !== UNASSIGNED_PROJECT_ID);

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
            {threads.map((t) => (
              <ThreadRow key={t.id} thread={t} projects={knownProjects} onAssigned={load} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
