import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import type { Db } from '../core/db.js';
import type { ProjectRegistry } from '../core/registry.js';
import type { WatchHandle } from '../core/watch.js';
import { updatePointerFiles } from '../core/pointer-files.js';
import * as claudeCode from '../core/adapters/claude-code.js';
import * as codex from '../core/adapters/codex.js';
import * as antigravity from '../core/adapters/antigravity.js';
import { archiveThread, deleteProject, type ArchiveRoots } from '../core/archive.js';
import type { EngineHealth, EngineType, SyncStats, WebSocketEvent } from '../types.js';
import { UNASSIGNED_PROJECT_ID } from '../types.js';

export interface AppDeps {
  db: Db;
  registry: ProjectRegistry;
  watchHandle: WatchHandle;
  /** Triggered by POST /api/sync/rescan — a full re-ingest of both engines. */
  rescan: () => void;
  /** Where archiveThread moves files it has no native archive location for (Claude Code). */
  archiveRoots: ArchiveRoots;
  /** Where deleteProject moves a project's real folder — defaults to the real ~/.Trash; override in tests. */
  trashRoot?: string;
  clientDistDir?: string;
  corsOrigins?: string[];
}

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
    unassignedThreadCount: db.countThreadsForProject(UNASSIGNED_PROJECT_ID),
    engines: engineHealth,
  };
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

  const app = Fastify({ logger: false });

  app.register(cors, { origin: deps.corsOrigins ?? true });
  app.register(fastifyWebsocket);

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

  app.get<{ Params: { id: string } }>('/api/threads/:id/messages', async (req, reply) => {
    const thread = db.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'not_found' });
    return db.getMessagesForThread(req.params.id);
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

  app.post('/api/sync/rescan', async () => {
    rescan();
    broadcast({ type: 'stats_updated', data: computeStats(deps) });
    return { ok: true, stats: computeStats(deps) };
  });

  return app;
}
