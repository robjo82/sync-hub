import { useEffect, useMemo, useState } from 'react';
import type { Project, SyncStats } from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';
import { api, connectSocket } from './lib/api.js';
import { Header } from './components/Header.js';
import { ProjectTree, type SelectedItem } from './components/ProjectTree.js';
import { WelcomeChecklist } from './components/WelcomeChecklist.js';
import { ChatView } from './components/ChatView.js';
import { DocumentViewer } from './components/DocumentViewer.js';
import { CoverageView } from './components/CoverageView.js';
import { UnassignedView } from './components/UnassignedView.js';
import { SearchView } from './components/SearchView.js';
import { CostsView } from './components/CostsView.js';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { SetupView } from './components/SetupView.js';
import { LoginView } from './components/LoginView.js';
import { SharedThreadView } from './components/SharedThreadView.js';
import { Loader2 } from 'lucide-react';

type Tab = 'projects' | 'coverage' | 'unassigned' | 'search' | 'costs';

function getShareTokenFromUrl(): string | null {
  const path = window.location.pathname;
  if (path.startsWith('/shared/')) {
    const token = path.slice('/shared/'.length).split('/')[0];
    if (token) return token;
  }
  const params = new URLSearchParams(window.location.search);
  const paramToken = params.get('share');
  if (paramToken) return paramToken;

  const hash = window.location.hash;
  if (hash.startsWith('#/shared/')) {
    return hash.slice('#/shared/'.length).split('?')[0];
  }
  return null;
}

function useTheme(): ['light' | 'dark', () => void] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('sync-hub-theme') === 'dark' ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('sync-hub-theme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

function MainDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<Tab>('projects');
  const [selected, setSelected] = useState<SelectedItem>(null);
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    Promise.all([api.projects(), api.stats()])
      .then(([p, s]) => {
        setProjects(p);
        setStats(s);
      })
      .catch((err) => {
        console.error('Failed to load initial projects/stats:', err);
      });

    const socket = connectSocket((event) => {
      setConnected(true);
      switch (event.type) {
        case 'initial_state':
          setProjects(event.data.projects);
          setStats(event.data.stats);
          break;
        case 'stats_updated':
          setStats(event.data);
          setRefreshToken((t) => t + 1);
          break;
        case 'project_updated':
          setProjects((prev) => {
            const others = prev.filter((p) => p.id !== event.data.id);
            return [...others, event.data].sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
          });
          setRefreshToken((t) => t + 1);
          break;
        case 'thread_updated':
          setRefreshToken((t) => t + 1);
          break;
      }
    });
    return () => socket.close();
  }, []);

  const visibleProjects = useMemo(() => projects.filter((p) => p.id !== UNASSIGNED_PROJECT_ID && !p.archived), [projects]);

  const refetchProjects = async () => {
    const [p, s] = await Promise.all([api.projects(), api.stats()]);
    setProjects(p);
    setStats(s);
    setRefreshToken((t) => t + 1);
  };

  const rescan = async () => {
    setScanning(true);
    try {
      await api.rescan();
      try {
        await api.syncPull();
      } catch {
        // Remote sync not configured or offline
      }
      await refetchProjects();
    } finally {
      setScanning(false);
    }
  };

  const openThread = (threadId: string) => {
    setTab('projects');
    setSelected({ kind: 'thread', id: threadId });
    setFocusThreadId(threadId);
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        connected={connected}
        scanning={scanning}
        onRescan={rescan}
        tab={tab}
        onTabChange={setTab}
        unassignedCount={stats?.unassignedThreadCount ?? 0}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="flex flex-1 overflow-hidden">
        {tab === 'projects' && (
          <>
            <ProjectTree
              projects={visibleProjects}
              selected={selected}
              onSelect={setSelected}
              refreshToken={refreshToken}
              onChanged={refetchProjects}
              focusThreadId={focusThreadId}
              onFocusHandled={() => setFocusThreadId(null)}
            />
            <main className="flex-1 overflow-y-auto">
              {selected?.kind === 'thread' && (
                <ChatView
                  key={selected.id}
                  threadId={selected.id}
                  allProjects={projects}
                  onChanged={refetchProjects}
                  onDeleted={() => setSelected(null)}
                />
              )}
              {(selected?.kind === 'memory' || selected?.kind === 'artifact') && <DocumentViewer document={selected} />}
              {!selected && (
                <div className="h-full overflow-y-auto">
                  {/* Renders nothing once the machine is set up and carrying data, so the usual
                      empty panel comes back for everyday use. */}
                  <WelcomeChecklist />
                  <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
                    Sélectionne un fil, une mémoire ou un artefact dans l'arbre.
                  </div>
                </div>
              )}
            </main>
          </>
        )}

        {tab === 'coverage' && <CoverageView />}
        {tab === 'unassigned' && <UnassignedView projects={projects} />}
        {tab === 'search' && <SearchView onOpenThread={openThread} />}
        {tab === 'costs' && <CostsView projects={projects} />}
      </div>
    </div>
  );
}

function AppContent() {
  const shareToken = useMemo(() => getShareTokenFromUrl(), []);

  if (shareToken) {
    return <SharedThreadView shareToken={shareToken} />;
  }

  const { user, loading, authEnabled, setupRequired } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
          <span className="text-sm font-medium">Chargement de Sync Hub...</span>
        </div>
      </div>
    );
  }

  // Only when authentication is actually in play. A local instance runs with no accounts on
  // purpose — the machine's own login is the boundary, and the SQLite file is readable anyway —
  // so forcing an account here would put a login screen in front of a single-user personal tool
  // without protecting anything. The hub, which has accounts, still gets the setup flow.
  if (setupRequired && authEnabled) {
    return <SetupView />;
  }

  if (authEnabled && !user) {
    return <LoginView />;
  }

  return <MainDashboard />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
