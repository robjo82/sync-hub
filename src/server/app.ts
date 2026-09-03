import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
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
import {
  formatThreadAsMarkdown,
  formatThreadAsJson,
  formatProjectAsMarkdown,
  formatProjectAsJson,
  sanitizeFilename,
} from '../core/export.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from '../core/mcp-server.js';
import type {
  EngineHealth,
  EngineType,
  PullBatch,
  PushBatch,
  PushResult,
  SecretScanResult,
  SyncOverview,
  SyncStats,
  User,
  UserRole,
  WebSocketEvent,
} from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    /**
     * How `user` was established. The sync endpoints need this: when no account exists yet the
     * hook hands every caller DEFAULT_LOCAL_USER so a fresh local install is usable without a
     * login, and a `user`-only check would let anyone push to, or pull the whole corpus from, a
     * hub whose admin has not been created yet.
     */
    authVia?: 'session' | 'apiToken' | 'sharedToken' | 'authDisabled';
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
  /**
   * Applies an enrolment made from the dashboard: persist the credential and start syncing now.
   * Absent on the hub, which is enrolled with nobody — it receives, it does not push.
   */
  onEnrol?: (hubUrl: string, token: string) => void;
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

/**
 * The sync endpoints accept only a credential someone actually presented — an api_token, or the
 * legacy shared secret during the migration. Never the DEFAULT_LOCAL_USER handed out when no
 * account exists yet: that convenience is for a single-user local dashboard, and letting it
 * through here would leave a not-yet-configured hub open to anyone who can reach it.
 */
function hasSyncCredential(req: FastifyRequest): boolean {
  return req.authVia === 'apiToken' || req.authVia === 'sharedToken';
}

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
        req.authVia = 'session';
      }
    }

    // A Bearer credential on the sync path resolves to a real user via api_tokens, so a push can
    // be attributed and a single machine revoked. deps.remoteToken stays honoured as a fallback:
    // the deployed hub and Robin's daemon are running on it right now, and cutting it here would
    // stop the sync mid-migration. It maps to DEFAULT_LOCAL_USER, which owns nothing — every
    // ownership decision keys off a real users.id.
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : null;
    if (bearer && !req.user) {
      const tokenUser = db.getUserByApiToken(hashSessionToken(bearer));
      if (tokenUser) {
        req.user = tokenUser;
        req.authVia = 'apiToken';
      }
    }
    if (!req.user && deps.remoteToken && bearer === deps.remoteToken) {
      // Resolve to the real admin when there is one, rather than the synthetic DEFAULT_LOCAL_USER:
      // owner_user_id is a foreign key, so a synthetic id cannot own anything, and applyRemoteBatch
      // skips a row whose insert fails — the push would answer 200 having stored nothing.
      req.user = db.getPrimaryAdmin() ?? DEFAULT_LOCAL_USER;
      req.authVia = 'sharedToken';
    }

    if (isAuthDisabled && !req.user) {
      req.user = DEFAULT_LOCAL_USER;
      req.authVia = 'authDisabled';
    }

    const rawUrl = req.raw.url ?? '';
    const path = rawUrl.split('?')[0];

    const isPublic =
      (!path.startsWith('/api') && !path.startsWith('/ws')) ||
      path === '/sse' ||
      path === '/api/mcp/sse' ||
      path === '/api/mcp/messages' ||
      path === '/api/health' ||
      path === '/api/auth/status' ||
      path === '/api/auth/setup' ||
      path === '/api/auth/login' ||
      path.startsWith('/api/share/');
    // /api/sync/push and /api/sync/pull are deliberately NOT public: they used to bypass this hook
    // entirely and answer to a shared secret, which meant any holder of that secret could pull the
    // whole corpus — every project, every client conversation — onto their machine.

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

    // Everything ingested before accounts existed has no owner. Reads filter on ownership, so
    // without this the first admin would log in to an empty dashboard sitting on top of a full
    // database. The first account to be created is by definition the person whose machine this is.
    const adopted = db.adoptOrphanProjects(user.id);
    if (adopted > 0) console.log(`sync-hub: ${adopted} projet(s) existants attribués à ${user.email}`);

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

  /**
   * Enrols this machine with a hub from the dashboard, so a newcomer never has to open a terminal.
   *
   * Local-only by design: the daemon binds 127.0.0.1, and anything that can reach it could equally
   * run `security` itself, so this adds no reach it did not already have. The token is checked
   * against the hub before being stored — a truncated paste fails here, visibly, rather than as a
   * sync that silently never happens.
   */
  app.post<{ Body: { hubUrl?: string; token?: string } }>('/api/enrol', async (req, reply) => {
    if (!deps.onEnrol) return reply.code(400).send({ error: 'not_supported', message: "Cette instance ne peut pas s'enrôler" });

    const hubUrl = (req.body?.hubUrl ?? '').trim().replace(/\/$/, '');
    const token = (req.body?.token ?? '').trim();
    if (!hubUrl || !token) return reply.code(400).send({ error: 'invalid_body', message: 'URL du hub et jeton requis' });

    let status: number;
    try {
      const res = await fetch(`${hubUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        // An empty batch: valid enough to authenticate, and changes nothing on the hub.
        body: JSON.stringify({ projects: [], threads: [], messages: [] }),
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
    } catch {
      return reply.code(502).send({ error: 'hub_unreachable', message: `Hub injoignable à ${hubUrl}` });
    }

    if (status === 401) return reply.code(401).send({ error: 'token_rejected', message: 'Jeton refusé — vérifie qu\'il est complet et non révoqué' });
    if (status !== 200) return reply.code(502).send({ error: 'hub_error', message: `Réponse inattendue du hub (HTTP ${status})` });

    deps.onEnrol(hubUrl, token);
    return { ok: true, hubUrl };
  });

  /**
   * Credential audit of the corpus. Admin-only: it lists, in one place, every secret sitting in
   * the store — a map worth having, and worth not handing to everyone with an account.
   */
  // Kept in memory rather than persisted: a completed scan is a list of where credentials live,
  // which is not something to write to disk next to the credentials themselves.
  interface SecretScanJob {
    status: 'running' | 'done';
    scanned: number;
    results: SecretScanResult[];
    finishedAt?: string;
  }
  let secretScan: SecretScanJob | null = null;

  app.get('/api/secrets/scan', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });

    if (!secretScan) {
      // A full pass is minutes of CPU on a real corpus, so it runs as a job and the client polls.
      // Answering it inline would hold an HTTP request open for three minutes and time out first.
      const job: SecretScanJob = { status: 'running', scanned: 0, results: [] };
      secretScan = job;
      void db
        .scanForSecrets((scanned) => {
          job.scanned = scanned;
        })
        .then((results) => {
          job.results = results;
          job.status = 'done';
          job.finishedAt = new Date().toISOString();
        })
        .catch((err) => {
          console.error('secret scan failed', err);
          secretScan = null;
        });
    }
    return secretScan;
  });

  /** Discards a finished scan so the next GET starts a fresh one. */
  app.post('/api/secrets/scan/restart', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });
    secretScan = null;
    return { ok: true };
  });

  /**
   * Removes one credential from every message and from the search index.
   *
   * Takes the plaintext, which the caller pastes back deliberately: the scan never returns it, so
   * redacting requires holding the secret already. That is the friction we want on an irreversible
   * operation against verbatim history — a mis-click cannot destroy a conversation.
   */
  app.post<{ Body: { value?: string; propagate?: boolean } }>('/api/secrets/redact', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Accès administrateur requis' });
    const value = req.body?.value ?? '';
    if (value.length < 8) return reply.code(400).send({ error: 'invalid_value', message: 'Valeur trop courte pour être un secret' });

    const result = db.redactSecret(value);
    secretScan = null; // the list it produced is now stale by construction
    broadcast({ type: 'stats_updated', data: computeStats(deps) });

    // The hub keeps its own copy, and a redaction never reaches it on its own: push only sends
    // messages newer than the watermark, and an edited message keeps its rank. Without this,
    // cleaning locally leaves the secret sitting on the machine everyone shares.
    // `propagate: false` is how the hub itself answers this call without bouncing it onward.
    let remote: { ok: boolean; messagesChanged?: number; occurrences?: number; error?: string } | null = null;
    if (req.body?.propagate !== false && deps.remoteUrl && deps.remoteToken) {
      try {
        const res = await fetch(`${deps.remoteUrl.replace(/\/$/, '')}/api/secrets/redact`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.remoteToken}` },
          body: JSON.stringify({ value, propagate: false }),
          signal: AbortSignal.timeout(120_000),
        });
        remote = res.ok
          ? { ok: true, ...((await res.json()) as { messagesChanged?: number; occurrences?: number }) }
          : { ok: false, error: res.status === 403 ? "Compte non administrateur sur le hub" : `HTTP ${res.status}` };
      } catch {
        // Reported rather than swallowed: a local-only redaction is a half-done job, and someone
        // who thinks it finished will not come back to it.
        remote = { ok: false, error: 'Hub injoignable' };
      }
    }

    return { ok: true, ...result, remote };
  });

  // --- Project sharing between colleagues. Only the owner may hand a project out: a share does
  // not confer the right to re-share, or access would spread without the owner ever knowing.
  app.get<{ Params: { id: string } }>('/api/projects/:id/shares', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (denyIfProjectHidden(req, reply, req.params.id)) return;
    return db.listProjectShares(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { email?: string; permission?: 'read' | 'write' } }>(
    '/api/projects/:id/shares',
    async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
      if (!db.ownsProject(req.user.id, req.params.id)) return reply.code(404).send({ error: 'not_found' });

      const email = (req.body?.email ?? '').trim();
      const target = email ? db.getUserByEmail(email) : undefined;
      if (!target) return reply.code(404).send({ error: 'user_not_found', message: 'Aucun compte avec cet email' });
      if (target.id === req.user.id) {
        return reply.code(400).send({ error: 'cannot_share_with_self', message: 'Ce projet vous appartient déjà' });
      }

      db.shareProject(req.params.id, target.id, req.user.id, req.body?.permission === 'write' ? 'write' : 'read');
      return { ok: true, shares: db.listProjectShares(req.params.id) };
    },
  );

  app.post<{ Params: { id: string; userId: string } }>('/api/projects/:id/shares/:userId/revoke', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (!db.ownsProject(req.user.id, req.params.id)) return reply.code(404).send({ error: 'not_found' });
    if (!db.unshareProject(req.params.id, req.params.userId)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, shares: db.listProjectShares(req.params.id) };
  });

  // --- Machine tokens: what a sync-hub daemon authenticates with. Each user manages their own;
  // there is no admin gate, because a token only ever grants that user's own access.
  app.get('/api/tokens', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    // tokenHash is dropped: it is not the secret, but it is not useful to a client either, and
    // sending it around invites someone to treat it as an identifier worth logging.
    return db.listApiTokens(req.user.id).map(({ tokenHash: _drop, ...rest }) => rest);
  });

  app.post<{ Body: { name?: string } }>('/api/tokens', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'invalid_name', message: 'Un nom est requis pour identifier la machine' });

    const plaintext = generateSessionToken(32);
    const created = db.createApiToken({ userId: req.user.id, tokenHash: hashSessionToken(plaintext), name });
    // The only moment the plaintext exists outside the caller's machine. It is not recoverable
    // afterwards by design — a lost token is revoked and replaced, never looked up.
    return { id: created.id, name: created.name, createdAt: created.createdAt, token: plaintext };
  });

  app.post<{ Params: { id: string } }>('/api/tokens/:id/revoke', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    if (!db.revokeApiToken(req.params.id, req.user.id)) {
      return reply.code(404).send({ error: 'not_found', message: 'Jeton introuvable ou déjà révoqué' });
    }
    return { ok: true };
  });

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

  /**
   * Stats and costs are pure functions of the stored corpus, and both are expensive: measured on
   * the deployed hub, 0.85s and 3.4-7.5s respectively, recomputed identically on every single
   * page load. They change only when something is ingested, so they are memoised against the
   * ingest counter — a new message invalidates them, nothing else needs to.
   */
  const memo = new Map<string, { version: number; value: unknown }>();
  function memoised<T>(key: string, compute: () => T): T {
    const version = db.ingestVersion();
    const hit = memo.get(key);
    if (hit && hit.version === version) return hit.value as T;
    const value = compute();
    // Bounded: without this, every distinct cost filter combination would be kept for the life of
    // the process. Aggregates are big, and the useful ones are the few most recently asked for.
    if (memo.size > 32) memo.clear();
    memo.set(key, { version, value });
    return value;
  }

  app.get('/api/stats', async () => memoised('stats', () => computeStats(deps)));

  /**
   * The set of project ids this request may see, or null when visibility does not apply.
   *
   * null is the local single-user case: the dashboard runs with no accounts, the hook hands every
   * request DEFAULT_LOCAL_USER, nothing is owned, and filtering would show an empty screen on top
   * of a full database. On the hub, where accounts exist, every read goes through this.
   */
  function visibleScope(req: FastifyRequest): Set<string> | null {
    if (req.authVia === 'authDisabled' || !req.user) return req.user ? null : new Set();
    if (req.user.id === DEFAULT_LOCAL_USER.id) return null;
    return new Set(db.visibleProjectIds(req.user.id));
  }

  /** Same guard for a thread, resolved through the project it belongs to. */
  function denyIfThreadHidden(req: FastifyRequest, reply: FastifyReply, threadId: string): boolean {
    const scope = visibleScope(req);
    if (scope === null) return false;
    const thread = db.getThread(threadId);
    // A thread that does not exist and one the caller may not see answer identically on purpose.
    if (thread && scope.has(thread.projectId)) return false;
    reply.code(404).send({ error: 'not_found' });
    return true;
  }

  /** Guard for a single project: 404 rather than 403, so a probe cannot enumerate what exists. */
  function denyIfProjectHidden(req: FastifyRequest, reply: FastifyReply, projectId: string): boolean {
    const scope = visibleScope(req);
    if (scope === null || scope.has(projectId)) return false;
    reply.code(404).send({ error: 'not_found' });
    return true;
  }

  app.get<{ Querystring: { includeArchived?: string } }>('/api/projects', async (req) => {
    const scope = visibleScope(req);
    let projects = db.getProjects();
    if (scope !== null) projects = projects.filter((p) => scope.has(p.id));
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
    // Search reads across every project at once, so without this it walks straight around the
    // per-project guards: a colleague could find a client conversation by keyword.
    const scope = visibleScope(req);
    const hits = db.searchTranscripts(query, limit).filter((m) => scope === null || scope.has(m.projectId));
    return hits.map((m) => ({
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
    memoised(`costs:${JSON.stringify(req.query)}`, () =>
      computeCostSummary(db, {
        projectId: req.query.projectId,
        threadId: req.query.threadId,
        engine: req.query.engine,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        eurRate: req.query.eurRate ? parseFloat(req.query.eurRate) : undefined,
      }),
    ),
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (denyIfProjectHidden(req, reply, req.params.id)) return;
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    return project;
  });

  app.get<{ Params: { id: string }; Querystring: { includeArchived?: string } }>('/api/projects/:id/threads', async (req, reply) => {
    if (denyIfProjectHidden(req, reply, req.params.id)) return;
    const threads = db.getThreadsForProject(req.params.id);
    return req.query.includeArchived === 'true' ? threads : threads.filter((t) => t.status !== 'archived');
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/memories', async (req, reply) => {
    if (denyIfProjectHidden(req, reply, req.params.id)) return;
    return db.getMemoriesForProject(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/artifacts', async (req, reply) => {
    if (denyIfProjectHidden(req, reply, req.params.id)) return;
    return db.getArtifactsForProject(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req, reply) => {
    if (denyIfThreadHidden(req, reply, req.params.id)) return;
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    return thread;
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/threads/:id/messages',
    async (req, reply) => {
      if (denyIfThreadHidden(req, reply, req.params.id)) return;
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
    if (denyIfThreadHidden(req, reply, req.params.id)) return;
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
    // Identity comes from the onRequest hook, which resolves an api_tokens credential to its
    // owner. There is no longer a shared secret standing in for "somebody".
    if (!req.user || !hasSyncCredential(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body;
    if (!body || !Array.isArray(body.projects) || !Array.isArray(body.threads) || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    // No stamping when the identity is the synthetic fallback (an instance with no accounts yet):
    // it is not a row in `users`, so the foreign key would reject it. Those projects stay
    // ownerless and get adopted when the first admin account is created.
    const owner = req.user.id === DEFAULT_LOCAL_USER.id ? undefined : req.user.id;
    const result = db.applyRemoteBatch(body, owner);
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, ...result } satisfies PushResult;
  });

  // Pulling end of remote sync (see core/sync-pull-client.ts for the pulling client). Returns a batch
  // of messages after `afterSeq` with referenced threads and projects for secondary devices.
  app.get<{ Querystring: { afterSeq?: string; limit?: string } }>('/api/sync/pull', async (req, reply) => {
    if (!req.user || !hasSyncCredential(req)) return reply.code(401).send({ error: 'unauthorized' });

    const afterSeq = Math.max(Number(req.query.afterSeq ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 1, 1), 200);

    // Scoped to the caller: before this, any holder of the shared secret pulled the whole
    // corpus — every project, every client conversation — onto their machine.
    return db.getPullBatch(afterSeq, limit, req.user.id === DEFAULT_LOCAL_USER.id ? undefined : req.user.id) satisfies PullBatch;
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

  // Returns comprehensive multi-account, multi-device and engine sync statistics.
  app.get('/api/sync/overview', async (): Promise<SyncOverview> => {
    return db.getSyncOverview(deps.remoteUrl);
  });

  // Export thread conversation as clean Markdown or JSON file.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/threads/:id/export', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    const project = (thread.projectId ? db.getProject(thread.projectId) : null) ?? null;
    const messages = db.getMessagesForThread(thread.id);
    const format = (req.query.format ?? 'markdown').toLowerCase();
    const filenameSlug = sanitizeFilename(thread.title || 'conversation');

    if (format === 'json') {
      const json = formatThreadAsJson(thread, project, messages);
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filenameSlug}.json"`);
      return reply.send(json);
    }

    const md = formatThreadAsMarkdown(thread, project, messages);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filenameSlug}.md"`);
    return reply.send(md);
  });

  // Export entire project (all conversations, prompts, thought trails and tools) as Markdown or JSON.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/projects/:id/export', async (req, reply) => {
    const project = db.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const threads = db.getThreadsForProject(project.id);
    const threadsWithMessages = threads.map((thread) => ({
      thread,
      messages: db.getMessagesForThread(thread.id),
    }));
    const format = (req.query.format ?? 'markdown').toLowerCase();
    const filenameSlug = sanitizeFilename(project.name || 'projet');

    if (format === 'json') {
      const json = formatProjectAsJson(project, threadsWithMessages);
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="projet-${filenameSlug}.json"`);
      return reply.send(json);
    }

    const md = formatProjectAsMarkdown(project, threadsWithMessages);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="projet-${filenameSlug}.md"`);
    return reply.send(md);
  });

  // MCP Remote Endpoint (Server-Sent Events)
  const mcpTransports = new Map<string, SSEServerTransport>();

  const handleMcpSse = async (_req: FastifyRequest, reply: any) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.hijack();
    const transport = new SSEServerTransport('/api/mcp/messages', reply.raw);
    const mcpServer = createMcpServer(deps.db, deps.registry, deps.archiveRoots);
    mcpTransports.set(transport.sessionId, transport);
    transport.onclose = () => {
      mcpTransports.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
  };

  app.get('/sse', handleMcpSse);
  app.get('/api/mcp/sse', handleMcpSse);

  // MCP POST messages handler
  app.post('/api/mcp/messages', async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string })?.sessionId;
    if (!sessionId) {
      return reply.code(400).send({ error: 'missing_session_id' });
    }
    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.hijack();
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
  });

  return app;
}
