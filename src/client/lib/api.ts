import type { Artifact, AuthStatus, Category, CreateSharedThreadInput, Memory, Message, Project, PublicSharedThreadData, PullResult, RemoteSyncState, SecretScanResult, SharedThread, SyncOverview, SyncStats, Thread, UpdateSharedThreadInput, User, UserRole, WebSocketEvent } from '../../types.js';
import type { CostSummary } from '../../core/cost.js';
import type { ActivitySummary } from '../../core/activity.js';

export interface ApiTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ProjectShare {
  userId: string;
  email: string;
  displayName: string;
  permission: string;
  createdAt: string;
}

export interface ThreadOutlineEntry {
  id: string;
  /** 0-based index in the full thread — the offset to load the window from. */
  position: number;
  timestamp: string;
  excerpt: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: init?.credentials ?? 'same-origin',
  });
  if (!res.ok) {
    let errorMessage = `${init?.method ?? 'GET'} ${url} → ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.message) errorMessage = errJson.message;
      else if (errJson?.error) errorMessage = errJson.error;
    } catch {
      // fallback to status error
    }
    const err = new Error(errorMessage);
    (err as any).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  // --- Auth ---
  authStatus: () => jsonFetch<AuthStatus>('/api/auth/status'),
  setup: (data: { email: string; displayName: string; password: string }) =>
    jsonFetch<{ user: User; token: string }>('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  login: (data: { email: string; password: string }) =>
    jsonFetch<{ user: User; token: string }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  logout: () => jsonFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => jsonFetch<{ user: User }>('/api/auth/me'),

  // --- Users Management ---
  users: () => jsonFetch<User[]>('/api/users'),

  // Machine tokens — what a sync-hub daemon authenticates with. The plaintext comes back only
  // from create(); afterwards the server has nothing but its hash to return.
  scanSecrets: () =>
    jsonFetch<{ status: 'running' | 'done'; scanned: number; results: SecretScanResult[]; finishedAt?: string }>(
      '/api/secrets/scan',
    ),
  restartSecretScan: () => jsonFetch<{ ok: true }>('/api/secrets/scan/restart', { method: 'POST' }),
  redactSecret: (value: string) =>
    jsonFetch<{
      ok: true;
      messagesChanged: number;
      occurrences: number;
      remote: { ok: boolean; messagesChanged?: number; occurrences?: number; error?: string } | null;
    }>('/api/secrets/redact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }),

  tokens: () => jsonFetch<ApiTokenSummary[]>('/api/tokens'),
  createToken: (name: string) =>
    jsonFetch<{ id: string; name: string; createdAt: string; token: string }>('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => jsonFetch<{ ok: true }>(`/api/tokens/${id}/revoke`, { method: 'POST' }),

  projectShares: (projectId: string) => jsonFetch<ProjectShare[]>(`/api/projects/${projectId}/shares`),
  shareProject: (projectId: string, email: string) =>
    jsonFetch<{ ok: true; shares: ProjectShare[] }>(`/api/projects/${projectId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  revokeProjectShare: (projectId: string, userId: string) =>
    jsonFetch<{ ok: true; shares: ProjectShare[] }>(`/api/projects/${projectId}/shares/${userId}/revoke`, { method: 'POST' }),
  createUser: (data: { email: string; displayName: string; password: string; role?: UserRole }) =>
    jsonFetch<User>('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateUser: (id: string, data: { email?: string; displayName?: string; password?: string; role?: UserRole }) =>
    jsonFetch<User>(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteUser: (id: string) => jsonFetch<{ ok: true }>(`/api/users/${id}`, { method: 'DELETE' }),

  // --- Sharing ---
  publicShare: (shareToken: string) => jsonFetch<PublicSharedThreadData>(`/api/share/${shareToken}`),
  threadShares: (threadId: string) => jsonFetch<SharedThread[]>(`/api/threads/${threadId}/shares`),
  createShare: (threadId: string, data: Omit<CreateSharedThreadInput, 'threadId'>) =>
    jsonFetch<SharedThread>(`/api/threads/${threadId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  allShares: () => jsonFetch<Array<SharedThread & { threadTitle: string; projectName?: string }>>('/api/shares'),
  updateShare: (id: string, data: UpdateSharedThreadInput) =>
    jsonFetch<SharedThread>(`/api/shares/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteShare: (id: string) => jsonFetch<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),

  // --- App Data ---
  stats: () => jsonFetch<SyncStats>('/api/stats'),
  projects: () => jsonFetch<Project[]>('/api/projects'),
  threads: (projectId: string) => jsonFetch<Thread[]>(`/api/projects/${projectId}/threads`),
  thread: (threadId: string) => jsonFetch<Thread>(`/api/threads/${threadId}`),
  memories: (projectId: string) => jsonFetch<Memory[]>(`/api/projects/${projectId}/memories`),
  artifacts: (projectId: string) => jsonFetch<Artifact[]>(`/api/projects/${projectId}/artifacts`),
  messages: (threadId: string, page?: { offset: number; limit: number }) =>
    jsonFetch<{ messages: Message[]; total: number }>(
      page
        ? `/api/threads/${threadId}/messages?offset=${page.offset}&limit=${page.limit}`
        : `/api/threads/${threadId}/messages`,
    ),
  threadOutline: (threadId: string) =>
    jsonFetch<ThreadOutlineEntry[]>(`/api/threads/${threadId}/outline`),
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
  costs: (scope?: {
    projectId?: string;
    threadId?: string;
    engine?: string;
    startDate?: string;
    endDate?: string;
    eurRate?: number;
  }) => {
    const params = new URLSearchParams();
    if (scope?.projectId) params.set('projectId', scope.projectId);
    if (scope?.threadId) params.set('threadId', scope.threadId);
    if (scope?.engine) params.set('engine', scope.engine);
    if (scope?.startDate) params.set('startDate', scope.startDate);
    if (scope?.endDate) params.set('endDate', scope.endDate);
    if (scope?.eurRate) params.set('eurRate', String(scope.eurRate));
    const qs = params.toString();
    return jsonFetch<CostSummary>(`/api/costs${qs ? `?${qs}` : ''}`);
  },
  approveDevice: (fingerprint: string, name: string) =>
    jsonFetch<{ id: string; name: string; createdAt: string }>('/api/tokens/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint, name }),
    }),
  activity: (scope?: { projectId?: string; threadId?: string; category?: string; startDate?: string; endDate?: string }) => {
    const params = new URLSearchParams();
    if (scope?.projectId) params.set('projectId', scope.projectId);
    if (scope?.threadId) params.set('threadId', scope.threadId);
    if (scope?.category) params.set('category', scope.category);
    if (scope?.startDate) params.set('startDate', scope.startDate);
    if (scope?.endDate) params.set('endDate', scope.endDate);
    const qs = params.toString();
    return jsonFetch<ActivitySummary>(`/api/activity${qs ? `?${qs}` : ''}`);
  },
  setTypingPace: (keystrokesPerMinute: number | null) =>
    jsonFetch<{ ok: true; keystrokesPerMinute: number }>('/api/account/typing-pace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keystrokesPerMinute }),
    }),
  search: (q: string) =>
    jsonFetch<{ message: Message; projectName: string; threadTitle: string }[]>(`/api/search?q=${encodeURIComponent(q)}`),
  rescan: () => jsonFetch<{ ok: true; stats: SyncStats }>('/api/sync/rescan', { method: 'POST' }),
  syncStatus: () =>
    jsonFetch<{
      configured: boolean;
      remoteUrl: string | null;
      syncState: RemoteSyncState | null;
      localIngest: boolean;
    }>('/api/sync/status'),
  syncOverview: () => jsonFetch<SyncOverview>('/api/sync/overview'),
  enrol: (hubUrl: string, token: string) =>
    jsonFetch<{ ok: true; hubUrl: string }>('/api/enrol', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hubUrl, token }),
    }),
  syncPull: () =>
    jsonFetch<{ ok: true; result: PullResult; syncState: RemoteSyncState }>('/api/sync/pull', { method: 'POST' }),
  archiveThread: (threadId: string) =>
    jsonFetch<{ thread: Thread; ok: boolean; movedFileTo?: string; note: string }>(`/api/threads/${threadId}/archive`, {
      method: 'POST',
    }),
  deleteThread: (threadId: string) =>
    jsonFetch<{ ok: boolean; movedFileTo?: string; note: string }>(`/api/threads/${threadId}/delete`, { method: 'POST' }),
  archiveProject: (projectId: string) =>
    jsonFetch<{ project: Project; threads: unknown[] }>(`/api/projects/${projectId}/archive`, { method: 'POST' }),
  unarchiveProject: (projectId: string) => jsonFetch<Project>(`/api/projects/${projectId}/unarchive`, { method: 'POST' }),
  renameProject: (projectId: string, name: string) =>
    jsonFetch<Project>(`/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  setProjectCategory: (projectId: string, category: string | null) =>
    jsonFetch<Project>(`/api/projects/${projectId}/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    }),
  categories: () => jsonFetch<Category[]>('/api/categories'),
  createCategory: (name: string) =>
    jsonFetch<Category[]>('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  renameCategory: (name: string, newName: string) =>
    jsonFetch<Category[]>(`/api/categories/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }),
  deleteCategory: (name: string) =>
    jsonFetch<{ ok: true; affected: number; categories: Category[] }>(`/api/categories/${encodeURIComponent(name)}/delete`, {
      method: 'POST',
    }),
  deleteProject: (projectId: string) =>
    jsonFetch<{ ok: boolean; movedFolderTo?: string; note: string }>(`/api/projects/${projectId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),
  mergeProjects: (targetProjectId: string, sourceProjectId: string) =>
    jsonFetch<Project>(`/api/projects/${targetProjectId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: sourceProjectId }),
    }),
  mergeProject: (targetProjectId: string, sourceProjectId: string) =>
    jsonFetch<Project>(`/api/projects/${targetProjectId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: sourceProjectId }),
    }),
  reorderProjects: (orderedIds: string[]) =>
    jsonFetch<{ ok: true }>('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }),
  uploadImport: (tool: 'claude' | 'chatgpt', file: File) => {
    const body = new FormData();
    body.append('file', file);
    return jsonFetch<{ ok: true; stats: SyncStats }>(`/api/imports/${tool}`, { method: 'POST', body });
  },
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
