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
  // The hub has no ~/.claude to detect tools in and never enrols itself, so every step here would
  // sit permanently unticked on it — an onboarding checklist that can never be completed.
  const [isLocal, setIsLocal] = useState(true);
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
  useEffect(() => {
    api
      .syncStatus()
      .then((st) => setIsLocal(st.localIngest !== false))
      .catch(() => {});
  }, []);

  // `remote` null means "not answered yet", not "not enrolled". Rendering during that window
  // announced that no device was connected — the first thing shown on opening the app, and
  // wrong: it corrected itself a few seconds later once the projects loaded.
  if (dismissed || !stats || !isLocal || remote === null) return null;

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
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Bienvenue sur sync-hub</h2>
            <p className="text-sm text-muted-foreground">
              Trois choses à vérifier pour que tout ton historique IA remonte ici.
            </p>
          </div>
          <button
            onClick={dismiss}
            title="Ne plus afficher"
            className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
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
            <p className="text-sm text-muted-foreground">
              Aucun outil IA trouvé pour l'instant. sync-hub lit les fichiers que Claude Code, Codex
              et Antigravity écrivent déjà sur ce Mac — utilise l'un d'eux une fois, puis reviens.
            </p>
          ) : (
            <ul className="space-y-2">
              {detected.map((e) => (
                <li key={e.engine} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <span className="text-muted-foreground">
                    {e.messageCount.toLocaleString('fr-FR')} messages
                    {e.watcherActive ? ' · suivi en direct' : ''}
                  </span>
                </li>
              ))}
              {missing.map((e) => (
                <li key={e.engine} className="flex items-center justify-between text-sm opacity-60">
                  <span className="text-muted-foreground">{ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <span className="text-muted-foreground">non installé</span>
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step done={enrolled} title="Appareil enrôlé auprès du hub" icon={<Cloud className="h-3.5 w-3.5" />}>
          {enrolled ? (
            <p className="text-sm text-muted-foreground">
              Connecté à <span className="text-foreground">{remote?.remoteUrl}</span>. Tes conversations y
              sont sauvegardées et te suivent d'un appareil à l'autre.
            </p>
          ) : (
            <EnrolForm onDone={load} />
          )}
        </Step>

        <Step
          done={false}
          optional
          title="Conversations cloud (Claude.ai, ChatGPT)"
          icon={<Cloud className="h-3.5 w-3.5" />}
        >
          <p className="mb-2 text-sm text-muted-foreground">
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
    <div className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-2">
        <span className={done ? 'text-success' : 'text-muted-foreground'}>
          {done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
        </span>
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {title}
        </span>
        {optional && <span className="text-sm text-muted-foreground">— optionnel</span>}
      </div>
      <div className="ml-6">{children}</div>
    </div>
  );
}

export function WelcomeChecklistLoading() {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Chargement…
    </div>
  );
}

/**
 * Enrolment without leaving the dashboard. The server verifies the token against the hub before
 * storing it, so a truncated paste is reported here rather than becoming a sync that never runs.
 */
function EnrolForm({ onDone }: { onDone: () => void }) {
  const [hubUrl, setHubUrl] = useState('https://sync-hub.robin-joseph.fr');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!hubUrl.trim() || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.enrol(hubUrl.trim(), token.trim());
      setToken('');
      onDone();
    } catch (err: any) {
      setError(err?.message?.includes('401') ? 'Jeton refusé — vérifie qu\'il est complet et non révoqué.' : "Hub injoignable ou jeton invalide.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-sm text-muted-foreground">
      <p className="mb-2">
        Cet appareil travaille en local : rien n'est sauvegardé à distance, et tu ne verras pas ce qu'on
        partage avec toi. Crée un jeton depuis le hub (menu compte → « Jetons d'appareil »), puis colle-le
        ici.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={hubUrl}
          onChange={(e) => setHubUrl(e.target.value)}
          placeholder="URL du hub"
          className="flex-1 rounded-xl border border-border bg-card px-2 py-2 text-sm text-foreground"
        />
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="jeton d'appareil"
          className="flex-1 rounded-xl border border-border bg-card px-2 py-2 text-sm text-foreground"
        />
        <button
          onClick={submit}
          disabled={busy || !token.trim()}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-40"
        >
          {busy ? 'Vérification…' : 'Enrôler'}
        </button>
      </div>
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
