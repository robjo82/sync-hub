import { useEffect, useMemo, useState } from 'react';
import type { Project, SyncStats } from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';
import { readCache, writeCache } from './lib/cache.js';
import { api, connectSocket } from './lib/api.js';
import { Header } from './components/Header.js';
import { ProjectTree, type SelectedItem } from './components/ProjectTree.js';
import { WelcomeChecklist } from './components/WelcomeChecklist.js';
import { ChatView } from './components/ChatView.js';
import { DocumentViewer } from './components/DocumentViewer.js';
import { CoverageView } from './components/CoverageView.js';
import { UnassignedView } from './components/UnassignedView.js';
import { SearchView } from './components/SearchView.js';
import { AccountView } from './components/AccountView.js';
import { CostsView } from './components/CostsView.js';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { SetupView } from './components/SetupView.js';
import { LoginView } from './components/LoginView.js';
import { SharedThreadView } from './components/SharedThreadView.js';

type Tab = 'projects' | 'coverage' | 'unassigned' | 'search' | 'costs' | 'account';

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
  // Seeded from the last known list so the tree is on screen before the network answers.
  const [projects, setProjects] = useState<Project[]>(() => readCache<Project[]>('projects') ?? []);
  const [projectsLoaded, setProjectsLoaded] = useState(() => readCache<Project[]>('projects') !== null);
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<Tab>('projects');
  const [selected, setSelected] = useState<SelectedItem>(null);
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    // Not Promise.all any more: stats is the slower of the two and the tree does not need it,
    // so waiting for both delayed the only thing the user actually looks at first.
    api
      .projects()
      .then((p) => {
        setProjects(p);
        setProjectsLoaded(true);
        writeCache('projects', p);
      })
      .catch((err) => console.error('Failed to load projects:', err));
    api
      .stats()
      .then(setStats)
      .catch((err) => {
        console.error('Failed to load stats:', err);
      });

    const socket = connectSocket((event) => {
      setConnected(true);
      switch (event.type) {
        case 'initial_state':
          setProjects(event.data.projects);
          setProjectsLoaded(true);
          writeCache('projects', event.data.projects);
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
              loaded={projectsLoaded}
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
        {tab === 'account' && (
          <AccountView
            onSelectThread={(id) => {
              setTab('projects');
              setFocusThreadId(id);
            }}
          />
        )}
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
    // The shell rather than a spinner: the header and the panel edges are known before any
    // request answers, so drawing them immediately makes the wait feel like the page arriving
    // instead of a blank screen. Palette colours, not the stray slate/indigo this used to carry.
    return (
      <div className="flex h-screen w-screen flex-col bg-background">
        <div className="flex items-center gap-4 border-b border-border bg-card px-6 py-4">
          <span className="text-base font-semibold tracking-tight text-foreground">Sync&nbsp;Hub</span>
          <div className="h-4 w-40 animate-pulse rounded-xl bg-muted" />
          <div className="flex-1" />
          <div className="h-4 w-24 animate-pulse rounded-xl bg-muted" />
        </div>
        <div className="flex flex-1">
          <div className="flex w-72 flex-col gap-2 border-r border-border p-6" aria-hidden>
            {[72, 56, 64, 48, 68, 52, 60].map((w, i) => (
              <div key={i} className="h-4 animate-pulse rounded-xl bg-muted" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center">
            <span className="text-sm text-muted-foreground">Chargement…</span>
          </div>
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
