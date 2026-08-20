import { useEffect, useState } from 'react';
import type { Project, Thread } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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
    <tr className="border-t border-slate-200 dark:border-slate-800">
      <td className="px-3 py-2 text-slate-800 dark:text-slate-200">{thread.title}</td>
      <td className="px-3 py-2 text-slate-500">{ENGINE_LABEL[thread.originEngine] ?? thread.originEngine}</td>
      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-400 dark:text-slate-600" title={thread.sourceRef}>
        {thread.sourceRef ?? '—'}
      </td>
      <td className="px-3 py-2 text-slate-500">{thread.messageCount}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
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
            className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-600 disabled:opacity-40 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400"
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
      <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Non affecté</h2>
      <p className="mb-4 text-xs text-slate-500">
        Sessions dont le dossier de travail ne correspond à aucun projet connu (dossiers fantômes générés par les outils, sessions
        lancées à la racine du home…). Assigne-les manuellement — sync-hub retiendra la correspondance pour la prochaine fois.
      </p>

      {!threads ? (
        <p className="text-sm text-slate-500">Chargement…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm text-slate-500">Rien à trier pour l'instant.</p>
      ) : (
        <table className="w-full border-collapse overflow-hidden rounded-lg border border-slate-200 text-sm dark:border-slate-800">
          <thead>
            <tr className="bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-900">
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
