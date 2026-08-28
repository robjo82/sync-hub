import { useEffect, useState } from 'react';
import { Cloud, CloudCheck, Moon, RefreshCw, Sun } from 'lucide-react';
import { UserMenu } from './UserMenu.js';
import { api } from '../lib/api.js';
import type { RemoteSyncState } from '../../types.js';

type Tab = 'projects' | 'coverage' | 'unassigned' | 'search' | 'costs';

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

const TABS: { key: Tab; label: string }[] = [
  { key: 'projects', label: 'Projets' },
  { key: 'search', label: 'Recherche' },
  { key: 'coverage', label: 'Synchronisation & Appareils' },
  { key: 'unassigned', label: 'Non affecté' },
  { key: 'costs', label: 'Coûts' },
];

export function Header({ connected, scanning, onRescan, tab, onTabChange, unassignedCount, theme, onToggleTheme }: HeaderProps) {
  const [syncStatus, setSyncStatus] = useState<{ configured: boolean; remoteUrl: string | null; syncState: RemoteSyncState | null } | null>(null);

  useEffect(() => {
    api.syncStatus().then(setSyncStatus).catch(() => {});
  }, [scanning]);

  return (
    <header className="flex items-center gap-4 border-b border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight text-foreground">Sync Hub</span>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`}
          title={connected ? 'Connecté (temps réel)' : 'Reconnexion…'}
        />
      </div>

      <nav className="flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer ${
              tab === t.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {t.label}
            {t.key === 'unassigned' && unassignedCount > 0 && (
              <span className="ml-1.5 rounded-full bg-warning-muted px-1.5 text-xs text-warning-foreground">{unassignedCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      {syncStatus?.configured && (
        <button
          onClick={() => onTabChange('coverage')}
          title={`Synchronisé avec ${syncStatus.remoteUrl} (Push: ${syncStatus.syncState?.lastPushedSeq ?? 0}, Pull: ${syncStatus.syncState?.lastPulledSeq ?? 0})`}
          className="hidden md:flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <Cloud size={13} className="text-success" />
          <span className="truncate max-w-[140px]">Distant synchronisé</span>
        </button>
      )}

      <button
        onClick={onToggleTheme}
        title={theme === 'light' ? 'Passer en thème sombre' : 'Passer en thème clair'}
        className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
      >
        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
      </button>

      <button
        onClick={onRescan}
        disabled={scanning}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 cursor-pointer"
      >
        <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
        {scanning ? 'Scan en cours…' : 'Rescanner'}
      </button>

      <UserMenu />
    </header>
  );
}
