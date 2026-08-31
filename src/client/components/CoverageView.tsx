import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  Computer,
  FolderGit2,
  HardDrive,
  Laptop,
  Loader2,
  RefreshCw,
  Server,
  Smartphone,
  Sparkles,
  Upload,
  User as UserIcon,
} from 'lucide-react';
import type { EngineType, SyncOverview } from '../../types.js';
import { formatRelative } from '../lib/format.js';
import { api } from '../lib/api.js';

interface CoverageRow {
  projectId: string;
  projectName: string;
  engines: Partial<Record<EngineType, string>>;
}

const KNOWN_ENGINES: { key: EngineType; label: string; colorClass: string }[] = [
  { key: 'claude-code', label: 'Claude Code', colorClass: 'text-engine-claude' },
  { key: 'codex', label: 'Codex / ChatGPT', colorClass: 'text-engine-codex' },
  { key: 'antigravity', label: 'Antigravity', colorClass: 'text-engine-antigravity' },
  // No 'cowork' row: Cowork sessions are ingested through the claude-code adapter and carry
  // sourceEngine 'claude-code', so the server never reports a 'cowork' engine (see app.ts's
  // engine list). Listing it here only ever produced a column that could not fill.
];

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
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-4 text-center text-xs transition-colors ${
        dragOver ? 'border-accent bg-accent-muted' : 'border-border bg-card hover:border-accent/40'
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
        <span className="flex items-center gap-1 text-success font-medium">
          <Check size={12} /> {state.message}
        </span>
      )}
      {state.status === 'error' && <span className="text-destructive">{state.message}</span>}
    </div>
  );
}

function getDeviceIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes('iphone') || l.includes('android') || l.includes('smartphone')) {
    return <Smartphone size={16} className="text-muted-foreground" />;
  }
  if (l.includes('macbook') || l.includes('laptop')) {
    return <Laptop size={16} className="text-muted-foreground" />;
  }
  if (l.includes('linux') || l.includes('serveur')) {
    return <Server size={16} className="text-muted-foreground" />;
  }
  return <Computer size={16} className="text-muted-foreground" />;
}

export function CoverageView() {
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [rows, setRows] = useState<CoverageRow[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [ov, cov] = await Promise.all([api.syncOverview(), api.coverage()]);
      setOverview(ov);
      setRows(cov);
    } catch {
      // Fallback
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleManualSync = async () => {
    setSyncing(true);
    setSyncFeedback(null);
    try {
      await api.rescan();
      const res = await api.syncPull();
      setSyncFeedback(`Synchronisation réussie (${res.result.appliedMessages} messages rapatriés).`);
      await loadData();
    } catch (err: any) {
      setSyncFeedback(err.message || 'Erreur lors de la synchronisation.');
    } finally {
      setSyncing(false);
    }
  };

  if (!overview || !rows) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Chargement de l'état de synchronisation…
      </div>
    );
  }

  const totalDevices = overview.accounts.reduce((acc, a) => acc + a.devices.length, 0);

  return (
    <div className="mx-auto max-w-4xl overflow-y-auto p-6 space-y-6">
      {/* Title & subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-foreground">Synchronisation & Appareils</h1>
          <p className="text-xs text-muted-foreground">
            Visualisation des appareils connectés, des IA installées et de la couverture par projet.
          </p>
        </div>
        {overview.remoteConfigured && (
          <button
            onClick={handleManualSync}
            disabled={syncing}
            className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer shadow-sm"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
          </button>
        )}
      </div>

      {syncFeedback && (
        <div className="p-3 rounded-xl bg-accent-muted text-accent-muted-foreground border border-accent/20 text-xs flex items-center gap-2">
          <Check size={14} className="text-accent shrink-0" />
          <span>{syncFeedback}</span>
        </div>
      )}

      {/* Top Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Hub Distant Card */}
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="font-medium">Hub Distant</span>
            <Cloud size={16} className={overview.remoteConfigured ? 'text-success' : 'text-muted-foreground'} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${overview.remoteConfigured ? 'bg-success' : 'bg-muted-foreground'}`} />
              <span className="text-sm font-semibold text-foreground">
                {overview.remoteConfigured ? 'En ligne' : 'Autonome'}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 truncate">
              {overview.remoteUrl || 'Stockage local uniquement'}
            </p>
          </div>
          {overview.syncState && (
            <div className="mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground flex justify-between">
              <span>Seq Push : {overview.syncState.lastPushedSeq}</span>
              <span>Seq Pull : {overview.syncState.lastPulledSeq}</span>
            </div>
          )}
        </div>

        {/* Devices Card */}
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="font-medium">Appareils & Sessions</span>
            <Laptop size={16} className="text-accent" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">{totalDevices}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {overview.accounts.length} {overview.accounts.length > 1 ? 'comptes actifs' : 'compte actif'}
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground">
            Multi-device & multi-session actif
          </div>
        </div>

        {/* AI Engines Card */}
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="font-medium">Moteurs IA</span>
            <Sparkles size={16} className="text-engine-claude" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">{overview.engines.length}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {overview.engines.map((e) => e.label.split(' ')[0]).join(', ')}
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground">
            Détection automatique multi-outils
          </div>
        </div>

        {/* History Volume Card */}
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="font-medium">Historique Centralisé</span>
            <HardDrive size={16} className="text-muted-foreground" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">{overview.totalMessages.toLocaleString('fr-FR')}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              messages dans {overview.totalThreads} conversations
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground">
            {overview.totalProjects} projets indexés en FTS5
          </div>
        </div>
      </div>

      {/* Section 1 : Comptes & Appareils Synchronisés */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <UserIcon size={14} className="text-accent" /> Comptes & Appareils Synchronisés
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {overview.accounts.map((acc) => (
            <div key={acc.user.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-accent-muted text-accent-muted-foreground flex items-center justify-center font-semibold text-xs">
                    {acc.user.displayName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-xs text-foreground">{acc.user.displayName}</span>
                      {acc.user.role === 'admin' && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-accent-muted text-accent-muted-foreground font-medium">
                          Admin
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{acc.user.email}</p>
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  Créé le {new Date(acc.user.createdAt).toLocaleDateString('fr-FR')}
                </span>
              </div>

              {/* Connected Devices List */}
              <div className="space-y-1.5 pt-2 border-t border-border/60">
                <div className="text-[10px] font-medium uppercase text-muted-foreground tracking-wider">
                  Appareils & Sessions ({acc.devices.length})
                </div>

                {acc.devices.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">Aucune session active enregistrée.</p>
                ) : (
                  acc.devices.map((dev) => (
                    <div
                      key={dev.id}
                      className="flex items-center justify-between rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-foreground"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {getDeviceIcon(dev.deviceLabel)}
                        <div className="min-w-0">
                          <p className="font-medium text-xs truncate">{dev.deviceLabel}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            IP : {dev.ip || 'locale'} · Connecté {formatRelative(dev.createdAt)}
                          </p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[10px] text-success font-medium shrink-0">
                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                        Actif
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 2 : Moteurs IA Détectés & Volume */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent" /> Moteurs IA Détectés sur l'Instance
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {overview.engines.map((eng) => (
            <div key={eng.engine} className="rounded-xl border border-border bg-card p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-foreground">{eng.label}</span>
                <span className="inline-flex items-center rounded-full bg-success-muted px-2 py-0.5 text-[10px] font-medium text-success">
                  Actif
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="text-lg font-bold text-foreground">{eng.messageCount.toLocaleString('fr-FR')}</div>
                <p className="text-[11px] text-muted-foreground">{eng.threadCount} conversations</p>
              </div>
              {eng.lastActiveAt && (
                <p className="text-[10px] text-muted-foreground pt-1.5 border-t border-border/60">
                  Dernière activité : {formatRelative(eng.lastActiveAt)}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Section 3 : Couverture par Projet */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <FolderGit2 size={14} className="text-accent" /> Couverture Projet par Projet
        </h2>

        <div className="border border-border rounded-xl overflow-hidden bg-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Projet</th>
                {KNOWN_ENGINES.map((e) => (
                  <th key={e.key} className="px-4 py-2.5 font-medium">
                    {e.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.projectId} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-foreground">{row.projectName}</td>
                  {KNOWN_ENGINES.map((e) => {
                    const at = row.engines[e.key];
                    return (
                      <td key={e.key} className="px-4 py-2.5">
                        {at ? (
                          <span className="flex items-center gap-1 text-success font-medium text-[11px]">
                            <Check size={12} /> {formatRelative(at)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-[11px]">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={1 + KNOWN_ENGINES.length} className="px-4 py-6 text-center text-muted-foreground">
                    Aucun projet synchronisé pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 4 : Import manuel d'archives */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Upload size={14} className="text-accent" /> Importer un export externe
        </h2>
        <p className="text-xs text-muted-foreground">
          Importez directement vos archives .zip depuis Claude.ai ou ChatGPT pour intégrer votre historique web complet.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ImportDropZone tool="claude" label="Claude.ai" onImported={loadData} />
          <ImportDropZone tool="chatgpt" label="ChatGPT" onImported={loadData} />
        </div>
      </div>
    </div>
  );
}
