import type { Artifact, Memory, Message, Project, SyncStats, Thread, WebSocketEvent } from '../../types.js';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => jsonFetch<SyncStats>('/api/stats'),
  projects: () => jsonFetch<Project[]>('/api/projects'),
  threads: (projectId: string) => jsonFetch<Thread[]>(`/api/projects/${projectId}/threads`),
  memories: (projectId: string) => jsonFetch<Memory[]>(`/api/projects/${projectId}/memories`),
  artifacts: (projectId: string) => jsonFetch<Artifact[]>(`/api/projects/${projectId}/artifacts`),
  messages: (threadId: string) => jsonFetch<Message[]>(`/api/threads/${threadId}/messages`),
  assign: (projectId: string, kind: 'paths' | 'claudeSlugs' | 'codexCwds', value: string) =>
    jsonFetch<Project>(`/api/projects/${projectId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value }),
    }),
  assignThread: (threadId: string, projectId: string) =>
    jsonFetch<Thread>(`/api/threads/${threadId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }),
  coverage: () =>
    jsonFetch<{ projectId: string; projectName: string; engines: Record<string, string> }[]>('/api/coverage'),
  search: (q: string) =>
    jsonFetch<{ message: Message; projectName: string; threadTitle: string }[]>(`/api/search?q=${encodeURIComponent(q)}`),
  rescan: () => jsonFetch<{ ok: true; stats: SyncStats }>('/api/sync/rescan', { method: 'POST' }),
  archiveThread: (threadId: string) =>
    jsonFetch<{ thread: Thread; ok: boolean; movedFileTo?: string; note: string }>(`/api/threads/${threadId}/archive`, {
      method: 'POST',
    }),
  archiveProject: (projectId: string) =>
    jsonFetch<{ project: Project; threads: unknown[] }>(`/api/projects/${projectId}/archive`, { method: 'POST' }),
  unarchiveProject: (projectId: string) => jsonFetch<Project>(`/api/projects/${projectId}/unarchive`, { method: 'POST' }),
  renameProject: (projectId: string, name: string) =>
    jsonFetch<Project>(`/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  deleteProject: (projectId: string) =>
    jsonFetch<{ ok: boolean; movedFolderTo?: string; note: string }>(`/api/projects/${projectId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),
  mergeProject: (sourceId: string, targetId: string) =>
    jsonFetch<Project>(`/api/projects/${targetId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId }),
    }),
  reorderProjects: (orderedIds: string[]) =>
    jsonFetch<{ ok: true }>('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }),
};

export function connectSocket(onEvent: (event: WebSocketEvent) => void): { close: () => void } {
  let socket: WebSocket | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data));
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (!closed) retryTimer = setTimeout(connect, 2000);
    };
  };
  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
