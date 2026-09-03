import { useEffect, useState } from 'react';
import { Cloud, Laptop, Moon, RefreshCw, Sun } from 'lucide-react';
import { UserMenu } from './UserMenu.js';
import { api } from '../lib/api.js';
import type { RemoteSyncState } from '../../types.js';

type Tab = 'projects' | 'coverage' | 'unassigned' | 'search' | 'costs' | 'activity' | 'account';

interface HeaderProps {
  connected: boolean;
  scanning: boolean;
  onRescan: () => void;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  unassignedCount: number;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

// Short labels: at 14px the full wording wrapped onto two lines and broke the header's height.
// The long form still titles the page itself, where there is room for it.
const TABS: { key: Tab; label: string }[] = [
  { key: 'projects', label: 'Projets' },
  { key: 'search', label: 'Recherche' },
  { key: 'coverage', label: 'Appareils' },
  { key: 'unassigned', label: 'Non affecté' },
  { key: 'costs', label: 'Coûts' },
  { key: 'activity', label: 'Temps' },
];

export function Header({ connected, scanning, onRescan, tab, onTabChange, unassignedCount, theme, onToggleTheme }: HeaderProps) {
  const [syncStatus, setSyncStatus] = useState<{
    configured: boolean;
    remoteUrl: string | null;
    syncState: RemoteSyncState | null;
    localIngest: boolean;
  } | null>(null);
  // Until the answer arrives, assume local: that is what every instance but the deployed hub is,
  // and it avoids the controls flickering out and back in on load.
  const isLocal = syncStatus?.localIngest !== false;

  useEffect(() => {
    api.syncStatus().then(setSyncStatus).catch(() => {});
  }, [scanning]);

  return (
    <header className="flex items-center gap-4 border-b border-border bg-card px-6 py-4">
      <div className="flex shrink-0 items-center gap-2">
        <span className="whitespace-nowrap text-base font-semibold tracking-tight text-foreground">Sync&nbsp;Hub</span>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`}
          title={connected ? 'Connecté (temps réel)' : 'Reconnexion…'}
        />
      </div>

      <nav className="flex items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm transition-colors cursor-pointer ${
              // The active tab used to be bg-muted, a 4% tint that was genuinely hard to pick out.
              tab === t.key
                ? 'bg-accent-muted font-medium text-accent-muted-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {t.label}
            {t.key === 'unassigned' && unassignedCount > 0 && (
              <span className="ml-2 rounded-full bg-warning-muted px-2 text-sm text-warning-foreground">{unassignedCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Which of the two you are looking at, stated rather than implied by a small dot. The
          local instance and the shared hub show the same screens, and mistaking one for the
          other is how someone concludes their data is missing. */}
      <div
        title={
          isLocal
            ? syncStatus?.configured
              ? `Cette machine, synchronisée avec ${syncStatus.remoteUrl}`
              : 'Cette machine, sans hub configuré'
            : 'Le hub partagé — les conversations de toute l’équipe'
        }
        className={`hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm md:flex ${
          isLocal ? 'bg-muted text-muted-foreground' : 'bg-accent-muted text-accent-muted-foreground'
        }`}
      >
        {isLocal ? <Laptop size={14} /> : <Cloud size={14} />}
        <span>{isLocal ? 'Cet appareil' : 'Hub partagé'}</span>
      </div>

      <button
        onClick={onToggleTheme}
        title={theme === 'light' ? 'Passer en thème sombre' : 'Passer en thème clair'}
        className="rounded-xl border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
      >
        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
      </button>

      {/* Nothing to rescan on the hub: it has no ~/.claude and no ~/Projets in its container. */}
      {isLocal && (
        <button
          onClick={onRescan}
          disabled={scanning}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Scan en cours…' : 'Rescanner'}
        </button>
      )}

      <UserMenu onOpenAccount={() => onTabChange('account')} />
    </header>
  );
}
