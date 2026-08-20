type Tab = 'projects' | 'coverage' | 'unassigned' | 'search';

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
  { key: 'coverage', label: 'Couverture de synchro' },
  { key: 'unassigned', label: 'Non affecté' },
];

export function Header({ connected, scanning, onRescan, tab, onTabChange, unassignedCount, theme, onToggleTheme }: HeaderProps) {
  return (
    <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">Sync Hub</span>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`}
          title={connected ? 'Connecté (temps réel)' : 'Reconnexion…'}
        />
      </div>

      <nav className="flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === t.key
                ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200'
            }`}
          >
            {t.label}
            {t.key === 'unassigned' && unassignedCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-xs text-amber-600 dark:text-amber-400">{unassignedCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      <button
        onClick={onToggleTheme}
        title={theme === 'light' ? 'Passer en thème sombre' : 'Passer en thème clair'}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
      >
        {theme === 'light' ? '🌙' : '☀️'}
      </button>

      <button
        onClick={onRescan}
        disabled={scanning}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
      >
        {scanning ? 'Scan en cours…' : 'Rescanner'}
      </button>
    </header>
  );
}
