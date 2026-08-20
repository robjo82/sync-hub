import { useEffect, useMemo, useState } from 'react';
import type { Project, SyncStats } from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';
import { api, connectSocket } from './lib/api.js';
import { Header } from './components/Header.js';
import { ProjectTree, type SelectedItem } from './components/ProjectTree.js';
import { ChatView } from './components/ChatView.js';
import { DocumentViewer } from './components/DocumentViewer.js';
import { CoverageView } from './components/CoverageView.js';
import { UnassignedView } from './components/UnassignedView.js';
import { SearchView } from './components/SearchView.js';
import { CostsView } from './components/CostsView.js';

type Tab = 'projects' | 'coverage' | 'unassigned' | 'search' | 'costs';

function useTheme(): [ 'light' | 'dark', () => void ] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('sync-hub-theme') === 'dark' ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('sync-hub-theme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<Tab>('projects');
  const [selected, setSelected] = useState<SelectedItem>(null);
  // Set when a thread is opened from somewhere other than clicking it directly in the tree (e.g.
  // search) — tells ProjectTree to expand/scroll to it once, then gets cleared so it doesn't
  // re-trigger the scroll on every unrelated re-render.
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    Promise.all([api.projects(), api.stats()]).then(([p, s]) => {
      setProjects(p);
      setStats(s);
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
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Sélectionne un fil, une mémoire ou un artefact dans l'arbre.
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
