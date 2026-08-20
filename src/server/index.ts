import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.js';
import { ProjectRegistry } from '../core/registry.js';
import { startWatching } from '../core/watch.js';
import { updateAllPointerFiles } from '../core/pointer-files.js';
import * as claudeCode from '../core/adapters/claude-code.js';
import * as codex from '../core/adapters/codex.js';
import * as cowork from '../core/adapters/cowork.js';
import * as antigravity from '../core/adapters/antigravity.js';
import { ingestAllMemories } from '../core/adapters/memories.js';
import { ingestClaudeExport } from '../core/adapters/claude-export.js';
import { ingestChatGptExport } from '../core/adapters/chatgpt-export.js';
import { createApp } from './app.js';

const PROJECTS_ROOT = process.env.SYNC_HUB_PROJECTS_ROOT ?? join(homedir(), 'Projets');
const DATA_DIR = process.env.SYNC_HUB_DATA_DIR ?? join(import.meta.dirname, '..', '..', 'data');
const IMPORTS_DIR = process.env.SYNC_HUB_IMPORTS_DIR ?? join(import.meta.dirname, '..', '..', 'imports');
const CLIENT_DIST = join(import.meta.dirname, '..', '..', 'dist', 'client');
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '127.0.0.1'; // local-only by default — this is a personal tool, not a network service

const db = new Db(join(DATA_DIR, 'hub.sqlite'));
const registry = new ProjectRegistry(db);
registry.bootstrapFromProjectsRoot(PROJECTS_ROOT);

function fullScan(): void {
  claudeCode.ingestAll(db, registry);
  codex.ingestAll(db, registry);
  cowork.ingestAll(db, registry);
  antigravity.ingestAll(db, registry);
  ingestAllMemories(db, registry);
  ingestClaudeExport(db, join(IMPORTS_DIR, 'claude'));
  ingestChatGptExport(db, join(IMPORTS_DIR, 'chatgpt'));
  updateAllPointerFiles(db);
}

console.log('sync-hub: scan initial en cours (peut prendre 15-20s la première fois)…');
fullScan();

const watchHandle = startWatching(db, registry, { onIngest: () => updateAllPointerFiles(db) });

const app = createApp({
  db,
  registry,
  watchHandle,
  rescan: fullScan,
  clientDistDir: CLIENT_DIST,
  archiveRoots: { syncHubArchiveRoot: join(DATA_DIR, 'archived-sessions') },
  importsDir: IMPORTS_DIR,
});

const address = await app.listen({ port: PORT, host: HOST });
app.log.info(`sync-hub écoute sur ${address}`);

async function shutdown(): Promise<void> {
  await watchHandle.close();
  await app.close();
  db.close();
  process.exit(0);
}

// SIGINT: Ctrl-C in a terminal. SIGTERM: what `launchctl unload`/`kill` send to stop the service.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
