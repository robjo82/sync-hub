import { useEffect, useState } from 'react';
import type { Project } from '../../types.js';
import type { CostSummary } from '../../core/cost.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';
import { api } from '../lib/api.js';

function formatUsd(n: number): string {
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatTokens(n: number): string {
  return n.toLocaleString('fr-FR');
}

export function CostsView({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState<string>('');
  const [summary, setSummary] = useState<CostSummary | null>(null);

  useEffect(() => {
    setSummary(null);
    api.costs(projectId ? { projectId } : undefined).then(setSummary);
  }, [projectId]);

  const visibleProjects = projects.filter((p) => p.id !== UNASSIGNED_PROJECT_ID && !p.archived);

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Consommation en tokens / coût estimé</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Estimation calculée à partir des tokens réellement rapportés par chaque outil et des tarifs API publics — ce n'est pas une
        reconstitution de ta facture réelle (l'usage Codex via abonnement ChatGPT n'est pas facturé au token). Couvre Claude Code et
        Codex ; Antigravity n'expose aucune donnée de token exploitable pour l'instant.
      </p>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="costs-project-filter">
          Projet
        </label>
        <select
          id="costs-project-filter"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
        >
          <option value="">Tous les projets</option>
          {visibleProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {!summary && <div className="text-sm text-muted-foreground">Chargement…</div>}

      {summary && (
        <>
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">Total estimé</div>
            <div className="text-2xl font-semibold text-foreground">{formatUsd(summary.totalCostUsd)}</div>
            {summary.unpricedMessageCount > 0 && (
              <div className="mt-1 text-xs text-warning-foreground">
                {summary.unpricedMessageCount} message(s) avec modèle/usage connus mais sans tarif publié — exclus du total, pas comptés
                comme gratuits.
              </div>
            )}
          </div>

          <table className="w-full border-collapse overflow-hidden rounded-lg border border-border text-sm">
            <thead>
              <tr className="bg-muted text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Modèle</th>
                <th className="px-3 py-2 font-medium">Messages</th>
                <th className="px-3 py-2 font-medium">Tokens entrée</th>
                <th className="px-3 py-2 font-medium">Tokens sortie</th>
                <th className="px-3 py-2 font-medium">Coût estimé</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((row) => (
                <tr key={row.model} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-foreground">{row.model}</td>
                  <td className="px-3 py-2 text-foreground">{row.messageCount}</td>
                  <td className="px-3 py-2 text-foreground">{formatTokens(row.inputTokens)}</td>
                  <td className="px-3 py-2 text-foreground">{formatTokens(row.outputTokens)}</td>
                  <td className="px-3 py-2 text-foreground">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
              {summary.byModel.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground/60">
                    Aucune donnée de coût pour ce périmètre.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
