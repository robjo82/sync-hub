import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Upload } from 'lucide-react';
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

type UploadState = { status: 'idle' } | { status: 'uploading' } | { status: 'done'; message: string } | { status: 'error'; message: string };

function ImportDropZone({ tool, label, onImported }: { tool: 'claude' | 'chatgpt'; label: string; onImported: () => void }) {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setState({ status: 'error', message: "Attendu : l'archive .zip telle que téléchargée, pas dézippée." });
      return;
    }
    setState({ status: 'uploading' });
    try {
      await api.uploadImport(tool, file);
      setState({ status: 'done', message: `${file.name} importé.` });
      onImported();
    } catch (err: any) {
      setState({ status: 'error', message: err?.message ?? 'Échec de l\'import.' });
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) upload(file);
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-4 text-center text-xs transition-colors ${
        dragOver ? 'border-accent bg-accent-muted' : 'border-border hover:border-accent/40'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
          e.target.value = '';
        }}
      />
      {state.status === 'uploading' ? (
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      ) : (
        <Upload size={18} className="text-muted-foreground" />
      )}
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground">Glisse l'export .zip ici, ou clique</span>
      {state.status === 'done' && (
        <span className="flex items-center gap-1 text-success">
          <Check size={12} /> {state.message}
        </span>
      )}
      {state.status === 'error' && <span className="text-destructive">{state.message}</span>}
    </div>
  );
}

export function CoverageView() {
  const [rows, setRows] = useState<CoverageRow[] | null>(null);

  const load = () => api.coverage().then(setRows);
  useEffect(() => {
    load();
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

      <h3 className="mt-6 mb-1 text-sm font-semibold text-foreground">Importer un export</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        L'archive .zip telle que fournie par « Exporter mes données » — Claude.ai (Réglages → Compte) ou ChatGPT (Réglages → Données).
      </p>
      <div className="grid grid-cols-2 gap-3">
        <ImportDropZone tool="claude" label="Claude.ai" onImported={load} />
        <ImportDropZone tool="chatgpt" label="ChatGPT" onImported={load} />
      </div>
    </div>
  );
}
