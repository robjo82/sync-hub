import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { Db } from '../core/db.js';
import type { ProjectRegistry } from '../core/registry.js';
import type { WatchHandle } from '../core/watch.js';
import { updatePointerFiles } from '../core/pointer-files.js';
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from '../core/crypto.js';
import * as claudeCode from '../core/adapters/claude-code.js';
import * as codex from '../core/adapters/codex.js';
import * as antigravity from '../core/adapters/antigravity.js';
import { archiveThread, deleteProject, deleteThread, type ArchiveRoots } from '../core/archive.js';
import { computeCostSummary } from '../core/cost.js';
import { runPullCycle } from '../core/sync-pull-client.js';
import type {
  EngineHealth,
  EngineType,
  PullBatch,
  PushBatch,
  PushResult,
  SyncStats,
  User,
  UserRole,
  WebSocketEvent,
} from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export interface AppDeps {
  db: Db;
  registry: ProjectRegistry;
  watchHandle: Pick<WatchHandle, 'isActive' | 'ready' | 'close'>;
  rescan: () => void;
  archiveRoots: ArchiveRoots;
  /** Where deleteProject moves a project's real folder — defaults to the real ~/.Trash; override in tests. */
  trashRoot?: string;
  /** Where an uploaded Claude.ai/ChatGPT export .zip is extracted (into <importsDir>/claude or /chatgpt). */
  importsDir: string;
  clientDistDir?: string;
  corsOrigins?: string[];
  /** Remote hub URL this instance connects to for bidirectional sync. */
  remoteUrl?: string;
  /** Shared secret guarding /api/sync/push and /api/sync/pull (see core/sync-push-client.ts) — unset means the
   * endpoint refuses every unauthenticated request. */
  remoteToken?: string;
  /** When true, authentication is disabled/bypassed (e.g. for purely local personal use). */
  authDisabled?: boolean;
  /** Secret used to sign session cookies. */
  cookieSecret?: string;
}

const execFileAsync = promisify(execFile);

export function computeStats(deps: Pick<AppDeps, 'db' | 'watchHandle'>): SyncStats {
  const { db, watchHandle } = deps;
  const engines: EngineType[] = ['claude-code', 'codex', 'antigravity'];
  const storageRootExists: Record<EngineType, () => boolean> = {
    'claude-code': claudeCode.storageRootExists,
    codex: codex.storageRootExists,
    antigravity: antigravity.storageRootExists,
  };
  const storageRoot: Record<EngineType, string> = {
    'claude-code': claudeCode.CLAUDE_CODE_STORAGE_ROOT,
    codex: codex.CODEX_SESSIONS_ROOT,
    antigravity: antigravity.ANTIGRAVITY_BRAIN_ROOT,
  };
  const engineHealth: EngineHealth[] = engines.map((engine) => ({
    engine,
    storageRootExists: storageRootExists[engine](),
    storageRoot: storageRoot[engine],
    watcherActive: watchHandle.isActive(),
    lastIngestAt: db.getLastIngestAt(engine),
    messageCount: db.countMessagesForEngine(engine),
  }));
  return {
    totalProjects: db.getProjects().filter((p) => p.id !== UNASSIGNED_PROJECT_ID).length,
    totalThreads: db.countAll('threads'),
    totalMessages: db.countAll('messages'),
    totalMemories: db.countAll('memories'),
    totalArtifacts: db.countAll('artifacts'),
    unassignedThreadCount: db.countThreadsForProject(UNASSIGNED_PROJECT_ID, 'active'),
    engines: engineHealth,
  };
}

const DEFAULT_LOCAL_USER: User = {
  id: 'local-admin',
  email: 'local@sync-hub',
  displayName: 'Robin',
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function extractSessionToken(req: FastifyRequest): string | null {
  const cookieToken = req.cookies?.sync_hub_session;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export function createApp(deps: AppDeps): FastifyInstance {
  const { db, registry, rescan } = deps;
  const sockets = new Set<WebSocket>();

  function broadcast(event: WebSocketEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  app.register(cors, { origin: deps.corsOrigins ?? true, credentials: true });
  app.register(fastifyCookie, { secret: deps.cookieSecret ?? 'sync-hub-cookie-secret-key-32chars-min' });
  app.register(fastifyWebsocket);
  app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

  // Authentication hook for all requests
  app.addHook('onRequest', async (req, reply) => {
    const isAuthDisabled = deps.authDisabled === true || process.env.SYNC_HUB_AUTH_DISABLED === '1' || db.countUsers() === 0;

    const token = extractSessionToken(req);
    if (token) {
      const tokenHash = hashSessionToken(token);
      const sessionResult = db.getSessionByTokenHash(tokenHash);
      if (sessionResult) {
        req.user = sessionResult.user;
      }
    }

    if (isAuthDisabled && !req.user) {
      req.user = DEFAULT_LOCAL_USER;
    }

    const rawUrl = req.raw.url ?? '';
    const path = rawUrl.split('?')[0];

    const isPublic =
      (!path.startsWith('/api') && !path.startsWith('/ws')) ||
      path === '/api/health' ||
      path === '/api/auth/status' ||
      path === '/api/auth/setup' ||
      path === '/api/auth/login' ||
      path === '/api/sync/push' ||
      path === '/api/sync/pull' ||
      path.startsWith('/api/share/');

    if (isPublic) return;

    if (!req.user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }
  });

  if (deps.clientDistDir && existsSync(deps.clientDistDir)) {
    app.register(fastifyStatic, { root: deps.clientDistDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({ type: 'initial_state', data: { projects: db.getProjects(), stats: computeStats(deps) } } satisfies WebSocketEvent),
      );
      socket.on('close', () => sockets.delete(socket));
    });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // --- Auth Routes ---

  app.get('/api/auth/status', async (req) => {
    const isAuthDisabled = deps.authDisabled === true || process.env.SYNC_HUB_AUTH_DISABLED === '1';
    const totalUsers = db.countUsers();
    const setupRequired = !isAuthDisabled && totalUsers === 0;
    const authEnabled = !isAuthDisabled && totalUsers > 0;
    return {
      authEnabled,
      setupRequired,
      user: req.user ?? null,
    };
  });

  app.post<{ Body: { email?: string; displayName?: string; password?: string } }>('/api/auth/setup', async (req, reply) => {
    if (db.countUsers() > 0) {
      return reply.code(403).send({ error: 'setup_already_completed', message: 'La configuration initiale a déjà été effectuée.' });
    }
    const email = (req.body?.email ?? '').trim();
    const displayName = (req.body?.displayName ?? '').trim();
    const password = req.body?.password ?? '';

    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email', message: 'Un email valide est requis' });
    }
    if (!displayName) {
      return reply.code(400).send({ error: 'display_name_required', message: 'Le nom complet est requis' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password_too_short', message: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    const passwordHash = await hashPassword(password);
    const user = db.createUser({
      email,
      displayName,
      passwordHash,
      role: 'admin',
    });

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    db.createSession({
      userId: user.id,
      tokenHash,
      expiresAt,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    reply.setCookie('sync_hub_session', rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 86400,
      secure: req.protocol === 'https',
    });

    return { user, token: rawToken };
  });

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const email = (req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';

    if (!email || !password) {
      return reply.code(400).send({ error: 'credentials_required', message: 'Email et mot de passe requis' });
    }

    const userWithHash = db.getUserByEmail(email);
    if (!userWithHash) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Identifiants invalides' });
    }

    const valid = await verifyPassword(password, userWithHash.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Identifiants invalides' });
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    db.createSession({
      userId: userWithHash.id,
      tokenHash,
      expiresAt,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    reply.setCookie('sync_hub_session', rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 86400,
      secure: req.protocol === 'https',
    });

    const { passwordHash: _, ...user } = userWithHash;
    return { user, token: rawToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = extractSessionToken(req);
    if (token) {
      db.deleteSessionByTokenHash(hashSessionToken(token));
    }
    reply.clearCookie('sync_hub_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return { user: req.user };
  });

  // --- Users Management Routes ---

  app.get('/api/users', async (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });
    }
    return db.listUsers();
  });

  app.post<{ Body: { email?: string; displayName?: string; password?: string; role?: UserRole } }>('/api/users', async (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });
    }
    const email = (req.body?.email ?? '').trim();
    const displayName = (req.body?.displayName ?? '').trim();
    const password = req.body?.password ?? '';
    const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'member';

    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email', message: 'Email valide requis' });
    }
    if (!displayName) {
      return reply.code(400).send({ error: 'display_name_required', message: 'Nom complet requis' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password_too_short', message: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    if (db.getUserByEmail(email)) {
      return reply.code(409).send({ error: 'email_already_exists', message: 'Un compte avec cet email existe déjà' });
    }

    const passwordHash = await hashPassword(password);
    const user = db.createUser({ email, displayName, passwordHash, role });
    return user;
  });

  app.patch<{ Params: { id: string }; Body: { email?: string; displayName?: string; password?: string; role?: UserRole } }>('/api/users/:id', async (req, reply) => {
    const targetId = req.params.id;
    const isSelf = req.user?.id === targetId;
    const isAdmin = req.user?.role === 'admin';

    if (!isSelf && !isAdmin) {
      return reply.code(403).send({ error: 'forbidden', message: 'Non autorisé' });
    }

    const updates: { email?: string; displayName?: string; passwordHash?: string; role?: UserRole } = {};
    if (req.body?.displayName !== undefined) updates.displayName = req.body.displayName;
    if (req.body?.email !== undefined) {
      if (req.body.email && !req.body.email.includes('@')) {
        return reply.code(400).send({ error: 'invalid_email' });
      }
      updates.email = req.body.email;
    }
    if (req.body?.password) {
      if (req.body.password.length < 8) {
        return reply.code(400).send({ error: 'password_too_short' });
      }
      updates.passwordHash = await hashPassword(req.body.password);
    }
    if (req.body?.role !== undefined) {
      if (!isAdmin) {
        return reply.code(403).send({ error: 'forbidden', message: 'Seul un administrateur peut modifier les rôles' });
      }
      updates.role = req.body.role;
    }

    const updated = db.updateUser(targetId, updates);
    if (!updated) return reply.code(404).send({ error: 'user_not_found' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });
    }
    const targetId = req.params.id;
    const targetUser = db.getUserById(targetId);
    if (!targetUser) return reply.code(404).send({ error: 'user_not_found' });

    if (targetUser.role === 'admin') {
      const allAdmins = db.listUsers().filter((u) => u.role === 'admin');
      if (allAdmins.length <= 1) {
        return reply.code(400).send({ error: 'cannot_delete_last_admin', message: 'Impossible de supprimer le dernier administrateur' });
      }
    }

    db.deleteSessionsForUser(targetId);
    db.deleteUser(targetId);
    return { ok: true };
  });

  // --- App Data Routes ---

  app.get('/api/stats', async () => computeStats(deps));

  app.get<{ Querystring: { includeArchived?: string } }>('/api/projects', async (req) => {
    const projects = db.getProjects();
    return req.query.includeArchived === 'true' ? projects : projects.filter((p) => !p.archived);
  });

  // Persists a drag-and-drop reorder from the dashboard. Rewrites sort_order for exactly the
  // given ids, in the order given — the client sends the full list it just reordered.
  app.post<{ Body: { orderedIds?: string[] } }>('/api/projects/reorder', async (req, reply) => {
    const orderedIds = req.body?.orderedIds;
    if (!orderedIds || orderedIds.length === 0) return reply.code(400).send({ error: 'ordered_ids_required' });
    db.setProjectOrder(orderedIds);
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req) => {
    const query = (req.query.q ?? '').trim();
    if (!query) return [];
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    return db.searchTranscripts(query, limit).map((m) => ({
      message: m,
      projectName: db.getProject(m.projectId)?.name ?? m.projectId,
      threadTitle: db.getThread(m.threadId)?.title ?? m.threadId,
    }));
  });

  app.get('/api/coverage', async () =>
    db
      .getProjects()
      .filter((p) => p.id !== UNASSIGNED_PROJECT_ID)
      .map((p) => ({ projectId: p.id, projectName: p.name, engines: db.getLastActivityByEngine(p.id) })),
  );

  app.get<{
    Querystring: {
      projectId?: string;
      threadId?: string;
      engine?: string;
      startDate?: string;
      endDate?: string;
      eurRate?: string;
    };
  }>('/api/costs', async (req) =>
    computeCostSummary(db, {
      projectId: req.query.projectId,
      threadId: req.query.threadId,
      engine: req.query.engine,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      eurRate: req.query.eurRate ? parseFloat(req.query.eurRate) : undefined,
    }),
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    return project;
  });

  app.get<{ Params: { id: string }; Querystring: { includeArchived?: string } }>('/api/projects/:id/threads', async (req) => {
    const threads = db.getThreadsForProject(req.params.id);
    return req.query.includeArchived === 'true' ? threads : threads.filter((t) => t.status !== 'archived');
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/memories', async (req) => db.getMemoriesForProject(req.params.id));

  app.get<{ Params: { id: string } }>('/api/projects/:id/artifacts', async (req) => db.getArtifactsForProject(req.params.id));

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    return thread;
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/threads/:id/messages',
    async (req, reply) => {
      const thread = db.getThread(req.params.id);
      if (!thread) return reply.code(404).send({ error: 'not_found' });

      const total = db.countMessagesForThread(req.params.id);
      // No limit given means "the whole thread", which stays valid for scripts and the MCP side.
      // The dashboard always pages; see getMessagesForThread for why that matters here.
      if (req.query.limit === undefined) {
        return { messages: db.getMessagesForThread(req.params.id), total };
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 0, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      return { messages: db.getMessagesForThread(req.params.id, { offset, limit }), total };
    },
  );

  app.get<{ Params: { id: string } }>('/api/threads/:id/outline', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    return db.getThreadOutline(req.params.id);
  });

  // --- Public Shared Thread Route (Exempt from auth) ---
  app.get<{ Params: { shareToken: string } }>('/api/share/:shareToken', async (req, reply) => {
    const { shareToken } = req.params;
    const shared = db.getSharedThreadByToken(shareToken);
    if (!shared) {
      return reply.code(404).send({ error: 'not_found', message: 'Ce lien de partage est invalide, a été révoqué ou a expiré' });
    }

    // Increment view count
    db.incrementSharedThreadViewCount(shareToken);

    const thread = db.getThread(shared.threadId);
    if (!thread) {
      return reply.code(404).send({ error: 'thread_not_found', message: 'La conversation partagée est introuvable' });
    }

    const messages = db.getMessagesForThread(shared.threadId);
    const project = db.getProject(thread.projectId) ?? null;

    return {
      sharedThread: shared,
      thread,
      messages,
      project,
    };
  });

  // --- Protected Sharing Management Routes ---

  app.get<{ Params: { id: string } }>('/api/threads/:id/shares', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    return db.listSharedThreadsForThread(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { title?: string; expiresAt?: string | null } }>(
    '/api/threads/:id/shares',
    async (req, reply) => {
      const thread = db.getThread(req.params.id);
      if (!thread) return reply.code(404).send({ error: 'not_found', message: 'Conversation introuvable' });

      const shared = db.createSharedThread(
        {
          threadId: req.params.id,
          title: req.body?.title,
          expiresAt: req.body?.expiresAt,
        },
        req.user?.id,
      );

      return reply.code(201).send(shared);
    },
  );

  app.get('/api/shares', async (req) => {
    const isGlobal = req.user?.role === 'admin';
    const shares = isGlobal ? db.listSharedThreads() : db.listSharedThreads(req.user?.id);
    return shares.map((s) => {
      const thread = db.getThread(s.threadId);
      const project = thread ? db.getProject(thread.projectId) : undefined;
      return {
        ...s,
        threadTitle: thread?.title ?? s.threadId,
        projectName: project?.name ?? thread?.projectId,
      };
    });
  });

  app.patch<{ Params: { id: string }; Body: { title?: string | null; isActive?: boolean; expiresAt?: string | null } }>(
    '/api/shares/:id',
    async (req, reply) => {
      const existing = db.getSharedThreadById(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      if (req.user?.role !== 'admin' && existing.createdByUserId && existing.createdByUserId !== req.user?.id) {
        return reply.code(403).send({ error: 'forbidden', message: 'Accès non autorisé à ce partage' });
      }

      const updated = db.updateSharedThread(req.params.id, req.body ?? {});
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (req, reply) => {
    const existing = db.getSharedThreadById(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (req.user?.role !== 'admin' && existing.createdByUserId && existing.createdByUserId !== req.user?.id) {
      return reply.code(403).send({ error: 'forbidden', message: 'Accès non autorisé à ce partage' });
    }

    db.deleteSharedThread(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { kind: 'paths' | 'claudeSlugs' | 'codexCwds'; value: string } }>(
    '/api/projects/:id/assign',
    async (req, reply) => {
      const { kind, value } = req.body;
      try {
        registry.assign(req.params.id, kind, value);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      const project = db.getProject(req.params.id)!;
      updatePointerFiles(db, project);
      broadcast({ type: 'project_updated', data: project });
      return project;
    },
  );

  // The triage action for the "unassigned" view: moves an existing thread to a real project
  // AND teaches the registry the thread's real cwd/slug, so future sessions from the same
  // source auto-resolve instead of landing in "unassigned" again.
  app.post<{ Params: { id: string }; Body: { projectId: string } }>('/api/threads/:id/assign', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    const targetProject = db.getProject(req.body.projectId);
    if (!targetProject) return reply.code(400).send({ error: 'unknown_target_project' });

    if (thread.sourceRef) {
      const kind = thread.originEngine === 'claude-code' ? 'claudeSlugs' : 'codexCwds';
      registry.assign(targetProject.id, kind, thread.sourceRef);
    }
    db.reassignThread(thread.id, targetProject.id);
    updatePointerFiles(db, targetProject);

    const updated = db.getThread(thread.id)!;
    broadcast({ type: 'thread_updated', data: updated });
    broadcast({ type: 'project_updated', data: db.getProject(targetProject.id)! });
    return updated;
  });

  // Moves the thread's real source file (Codex → its own archived_sessions/, Claude Code → a
  // sync-hub-managed archive folder — never deleted, always recoverable) and hides it from the
  // default dashboard view.
  app.post<{ Params: { id: string } }>('/api/threads/:id/archive', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });

    const result = archiveThread(db, thread, deps.archiveRoots);
    const updated = db.getThread(thread.id)!;
    broadcast({ type: 'thread_updated', data: updated });
    return { thread: updated, ...result };
  });

  // Purges the thread from sync-hub's own store (its real source file is moved aside first, same
  // as archiveThread — never deleted, never left where a rescan would silently re-ingest it).
  app.post<{ Params: { id: string } }>('/api/threads/:id/delete', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });

    const result = deleteThread(db, thread, deps.archiveRoots);
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return result;
  });

  // Project-level archive: hides the project and cascades archiveThread to every one of its
  // still-active threads (best-effort — one failing file move doesn't block the rest).
  app.post<{ Params: { id: string } }>('/api/projects/:id/archive', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    if (project.id === UNASSIGNED_PROJECT_ID) return reply.code(400).send({ error: 'cannot_archive_unassigned' });

    const results = db
      .getThreadsForProject(project.id)
      .filter((t) => t.status === 'active')
      .map((t) => ({ threadId: t.id, ...archiveThread(db, t, deps.archiveRoots) }));

    db.setProjectArchived(project.id, true);
    const updatedProject = db.getProject(project.id)!;
    broadcast({ type: 'project_updated', data: updatedProject });
    return { project: updatedProject, threads: results };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/unarchive', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    db.setProjectArchived(project.id, false);
    const updatedProject = db.getProject(project.id)!;
    broadcast({ type: 'project_updated', data: updatedProject });
    return updatedProject;
  });

  app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/projects/:id/rename', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name_required' });

    db.renameProject(project.id, name);
    const updatedProject = db.getProject(project.id)!;
    broadcast({ type: 'project_updated', data: updatedProject });
    return updatedProject;
  });

  app.post<{ Params: { id: string }; Body: { category?: string | null } }>('/api/projects/:id/category', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const category = req.body?.category?.trim() || null;

    db.setProjectCategory(project.id, category);
    const updatedProject = db.getProject(project.id)!;
    broadcast({ type: 'project_updated', data: updatedProject });
    return updatedProject;
  });

  app.get('/api/categories', async () => db.listCategories());

  app.post<{ Body: { name?: string } }>('/api/categories', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name_required' });
    db.createCategory(name);
    return db.listCategories();
  });

  app.post<{ Params: { name: string }; Body: { name?: string } }>('/api/categories/:name/rename', async (req, reply) => {
    const newName = req.body?.name?.trim();
    if (!newName) return reply.code(400).send({ error: 'name_required' });
    try {
      db.renameCategory(req.params.name, newName);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return db.listCategories();
  });

  app.post<{ Params: { name: string } }>('/api/categories/:name/delete', async (req) => {
    const affected = db.deleteCategory(req.params.name);
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, affected, categories: db.listCategories() };
  });

  // Moves the project's real folder to the macOS Trash (never a permanent rm -rf) and removes it
  // from sync-hub's own store. Requires the caller to pass confirm:true as a small extra safety
  // layer beyond the dashboard's own confirmation dialog, given this touches a real folder.
  app.post<{ Params: { id: string }; Body: { confirm?: boolean } }>('/api/projects/:id/delete', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    if (project.id === UNASSIGNED_PROJECT_ID) return reply.code(400).send({ error: 'cannot_delete_unassigned' });
    if (!req.body?.confirm) return reply.code(400).send({ error: 'confirmation_required' });

    const result = deleteProject(db, project, { trashRoot: deps.trashRoot });
    if (!result.ok) return reply.code(500).send(result);
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return result;
  });

  // Folds sourceId into targetId (see Db.mergeProjects) — a pure DB reassignment, never touches
  // real files. Used when the same real project was independently discovered under two identities
  // (e.g. a live Codex project and an unrelated-looking ChatGPT Project).
  app.post<{ Params: { id: string }; Body: { sourceId?: string } }>('/api/projects/:id/merge', async (req, reply) => {
    const targetId = req.params.id;
    const sourceId = req.body?.sourceId;
    if (!sourceId) return reply.code(400).send({ error: 'source_id_required' });
    if (sourceId === UNASSIGNED_PROJECT_ID || targetId === UNASSIGNED_PROJECT_ID) {
      return reply.code(400).send({ error: 'cannot_merge_unassigned' });
    }
    if (!db.getProject(sourceId) || !db.getProject(targetId)) return reply.code(404).send({ error: 'not_found' });

    try {
      db.mergeProjects(sourceId, targetId);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    const mergedProject = db.getProject(targetId)!;
    updatePointerFiles(db, mergedProject);
    broadcast({ type: 'project_updated', data: mergedProject });
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return mergedProject;
  });

  // Onboarding: drop a Claude.ai/ChatGPT "export your data" .zip straight from the dashboard
  // instead of having to unzip it into imports/<tool>/ by hand. Extracted with the system `unzip`
  // (macOS-only, already a hard requirement elsewhere) rather than a new zip-parsing dependency.
  app.post<{ Params: { tool: string } }>('/api/imports/:tool', async (req, reply) => {
    const { tool } = req.params;
    if (tool !== 'claude' && tool !== 'chatgpt') return reply.code(400).send({ error: 'unknown_tool' });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'file_required' });
    if (!data.filename.toLowerCase().endsWith('.zip')) return reply.code(400).send({ error: 'zip_required' });

    const tmpZipPath = join(tmpdir(), `sync-hub-import-${randomUUID()}.zip`);
    await pipeline(data.file, createWriteStream(tmpZipPath));
    if (data.file.truncated) {
      rmSync(tmpZipPath, { force: true });
      return reply.code(413).send({ error: 'file_too_large' });
    }

    const targetDir = join(deps.importsDir, tool);
    mkdirSync(targetDir, { recursive: true });
    try {
      await execFileAsync('/usr/bin/unzip', ['-o', tmpZipPath, '-d', targetDir]);
    } catch (err: any) {
      return reply.code(500).send({ error: 'unzip_failed', message: err.message });
    } finally {
      rmSync(tmpZipPath, { force: true });
    }

    rescan();
    const stats = computeStats(deps);
    broadcast({ type: 'stats_updated', data: stats });
    return { ok: true, stats };
  });

  app.post('/api/sync/rescan', async () => {
    rescan();
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, stats: computeStats(deps) };
  });

  // Receiving end of remote sync (see core/sync-push-client.ts for the pushing side). Applies a
  // batch via the exact same upsertProject/upsertThread/insertMessage this store uses for its own
  // local ingestion — this route is what makes an instance a "remote hub" rather than a purely
  // local store. Fails closed: no configured token means no writes accepted, never the reverse.
  app.post<{ Body: PushBatch }>('/api/sync/push', async (req, reply) => {
    if (!deps.remoteToken) return reply.code(403).send({ error: 'push_disabled' });
    if (req.headers.authorization !== `Bearer ${deps.remoteToken}`) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body;
    if (!body || !Array.isArray(body.projects) || !Array.isArray(body.threads) || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const result = db.applyRemoteBatch(body);
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, ...result } satisfies PushResult;
  });

  // Pulling end of remote sync (see core/sync-pull-client.ts for the pulling client). Returns a batch
  // of messages after `afterSeq` with referenced threads and projects for secondary devices.
  app.get<{ Querystring: { afterSeq?: string; limit?: string } }>('/api/sync/pull', async (req, reply) => {
    if (!deps.remoteToken) return reply.code(403).send({ error: 'pull_disabled' });
    if (req.headers.authorization !== `Bearer ${deps.remoteToken}`) return reply.code(401).send({ error: 'unauthorized' });

    const afterSeq = Math.max(Number(req.query.afterSeq ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 1, 1), 200);

    return db.getPullBatch(afterSeq, limit) satisfies PullBatch;
  });

  // Local-side manual trigger to pull the latest updates from the configured remote hub on demand.
  app.post('/api/sync/pull', async (_req, reply) => {
    if (!deps.remoteUrl || !deps.remoteToken) {
      return reply.code(400).send({ error: 'remote_not_configured', message: 'Aucun hub distant configuré pour la synchronisation' });
    }
    const result = await runPullCycle(db, {
      remoteUrl: deps.remoteUrl,
      remoteToken: deps.remoteToken,
    });
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, result, syncState: db.getRemoteSyncState(deps.remoteUrl) };
  });

  // Returns the current bidirectional sync configuration and watermarks.
  app.get('/api/sync/status', async () => {
    const configured = !!(deps.remoteUrl && deps.remoteToken);
    const syncState = deps.remoteUrl ? db.getRemoteSyncState(deps.remoteUrl) : null;
    return {
      configured,
      remoteUrl: deps.remoteUrl ?? null,
      syncState,
    };
  });

  return app;
}
