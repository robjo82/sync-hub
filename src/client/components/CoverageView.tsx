import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { EngineType } from '../../types.js';
import { formatRelative } from '../lib/format.js';
import { api } from '../lib/api.js';

interface CoverageRow {
  projectId: string;
  projectName: string;
  engines: Partial<Record<EngineType, string>>;
}

// Cowork sessions run real Claude Code internally, and bulk-imported ChatGPT web conversations
// are tagged 'codex' too (closest fit in a two-engine model) — both genuinely flow into these
// columns, not just their CLI namesakes, hence the combined labels.
const KNOWN_ENGINES: { key: EngineType; label: string }[] = [
  { key: 'claude-code', label: 'Claude Code / Cowork' },
  { key: 'codex', label: 'Codex / ChatGPT' },
  { key: 'antigravity', label: 'Antigravity' },
];

const BACKLOG_ENGINES: string[] = [];

export function CoverageView() {
  const [rows, setRows] = useState<CoverageRow[] | null>(null);

  useEffect(() => {
    api.coverage().then(setRows);
  }, []);

  if (!rows) return <div className="p-6 text-sm text-muted-foreground">Chargement…</div>;

  return (
    <div className="mx-auto max-w-3xl overflow-y-auto p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Couverture de synchro</h2>
      <p className="mb-4 text-xs text-muted-foreground">Ce qui est réellement synchronisé, projet par projet, et depuis combien de temps.</p>

      <table className="w-full border-collapse overflow-hidden rounded-lg border border-border text-sm">
        <thead>
          <tr className="bg-muted text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Projet</th>
            {KNOWN_ENGINES.map((e) => (
              <th key={e.key} className="px-3 py-2 font-medium">
                {e.label}
              </th>
            ))}
            {BACKLOG_ENGINES.map((label) => (
              <th key={label} className="px-3 py-2 font-medium text-muted-foreground/60">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.projectId} className="border-t border-border">
              <td className="px-3 py-2 text-foreground">{row.projectName}</td>
              {KNOWN_ENGINES.map((e) => {
                const at = row.engines[e.key];
                return (
                  <td key={e.key} className="px-3 py-2">
                    {at ? (
                      <span className="flex items-center gap-1 text-success">
                        <Check size={13} /> {formatRelative(at)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">— aucune activité</span>
                    )}
                  </td>
                );
              })}
              {BACKLOG_ENGINES.map((label) => (
                <td key={label} className="px-3 py-2 text-muted-foreground/60">
                  pas encore supporté
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={2 + KNOWN_ENGINES.length + BACKLOG_ENGINES.length} className="px-3 py-4 text-center text-muted-foreground/60">
                Aucun projet connu pour l'instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
