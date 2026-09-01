import { useEffect, useState } from 'react';
import { Check, Circle, Cloud, HardDrive, Loader2, X } from 'lucide-react';
import type { SyncStats } from '../../types.js';
import { api } from '../lib/api.js';
import { ImportDropZone } from './CoverageView.js';

const DISMISSED_KEY = 'sync-hub:welcome-dismissed';

const ENGINE_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex / ChatGPT CLI',
  antigravity: 'Antigravity',
};

/**
 * First-run checklist. A fresh install otherwise opens on an empty tree with nothing explaining
 * what it is waiting for — the three things that actually decide whether sync-hub works are
 * invisible: which AI tools it found on this machine, whether the machine is enrolled with a hub,
 * and that cloud conversations only arrive via an exported archive.
 *
 * Shown until dismissed, and again for anyone whose store is still empty.
 */
export function WelcomeChecklist() {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [remote, setRemote] = useState<{ remoteConfigured: boolean; remoteUrl?: string } | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Private windows and blocked site data make this throw; a missing preference just means
      // the checklist shows, which is the harmless direction.
      return false;
    }
  });

  const load = () => {
    api.stats().then(setStats).catch(() => setStats(null));
    api
      .syncOverview()
      .then((o) => setRemote({ remoteConfigured: o.remoteConfigured, remoteUrl: o.remoteUrl ?? undefined }))
      .catch(() => setRemote({ remoteConfigured: false }));
  };

  useEffect(load, []);

  if (dismissed || !stats) return null;

  const detected = stats.engines.filter((e) => e.storageRootExists);
  const missing = stats.engines.filter((e) => !e.storageRootExists);
  const hasLocalData = stats.totalMessages > 0;
  const enrolled = remote?.remoteConfigured === true;

  // Once the machine is set up and carrying data, the checklist has nothing left to say.
  if (hasLocalData && enrolled) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to do — it will simply show again next time.
    }
    setDismissed(true);
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Bienvenue sur sync-hub</h2>
            <p className="text-xs text-muted-foreground">
              Trois choses à vérifier pour que tout ton historique IA remonte ici.
            </p>
          </div>
          <button
            onClick={dismiss}
            title="Ne plus afficher"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <Step
          done={detected.length > 0}
          title="Applications détectées sur cet appareil"
          icon={<HardDrive className="h-3.5 w-3.5" />}
        >
          {detected.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Aucun outil IA trouvé pour l'instant. sync-hub lit les fichiers que Claude Code, Codex
              et Antigravity écrivent déjà sur ce Mac — utilise l'un d'eux une fois, puis reviens.
            </p>
          ) : (
            <ul className="space-y-1">
              {detected.map((e) => (
                <li key={e.engine} className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <span className="text-muted-foreground">
                    {e.messageCount.toLocaleString('fr-FR')} messages
                    {e.watcherActive ? ' · suivi en direct' : ''}
                  </span>
                </li>
              ))}
              {missing.map((e) => (
                <li key={e.engine} className="flex items-center justify-between text-xs opacity-60">
                  <span className="text-muted-foreground">{ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <span className="text-muted-foreground">non installé</span>
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step done={enrolled} title="Appareil enrôlé auprès du hub" icon={<Cloud className="h-3.5 w-3.5" />}>
          {enrolled ? (
            <p className="text-xs text-muted-foreground">
              Connecté à <span className="text-foreground">{remote?.remoteUrl}</span>. Tes conversations y
              sont sauvegardées et te suivent d'un appareil à l'autre.
            </p>
          ) : (
            <div className="text-xs text-muted-foreground">
              <p className="mb-1.5">
                Cet appareil travaille en local : rien n'est sauvegardé à distance, et tu ne verras pas ce
                qu'on partage avec toi.
              </p>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                ./scripts/enroll.sh
              </code>
              <span className="ml-1.5">depuis le dossier sync-hub, puis relance le service.</span>
            </div>
          )}
        </Step>

        <Step
          done={false}
          optional
          title="Conversations cloud (Claude.ai, ChatGPT)"
          icon={<Cloud className="h-3.5 w-3.5" />}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Ces outils ne stockent rien sur ton Mac : leur historique n'arrive que par un export. Demande
            ton archive dans leurs réglages, puis dépose le .zip ici.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <ImportDropZone tool="claude" label="Claude.ai" onImported={load} />
            <ImportDropZone tool="chatgpt" label="ChatGPT" onImported={load} />
          </div>
        </Step>
      </div>
    </div>
  );
}

function Step({
  done,
  optional,
  title,
  icon,
  children,
}: {
  done: boolean;
  optional?: boolean;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={done ? 'text-success' : 'text-muted-foreground'}>
          {done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
        </span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {icon}
          {title}
        </span>
        {optional && <span className="text-[11px] text-muted-foreground">— optionnel</span>}
      </div>
      <div className="ml-6">{children}</div>
    </div>
  );
}

export function WelcomeChecklistLoading() {
  return (
    <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Chargement…
    </div>
  );
}
