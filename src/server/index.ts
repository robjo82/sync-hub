import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.js';
import { ProjectRegistry } from '../core/registry.js';
import { startWatching, type WatchHandle } from '../core/watch.js';
import { updateAllPointerFiles } from '../core/pointer-files.js';
import * as claudeCode from '../core/adapters/claude-code.js';
import * as codex from '../core/adapters/codex.js';
import * as cowork from '../core/adapters/cowork.js';
import * as antigravity from '../core/adapters/antigravity.js';
import { ingestAllMemories } from '../core/adapters/memories.js';
import { ingestClaudeExport } from '../core/adapters/claude-export.js';
import { ingestChatGptExport } from '../core/adapters/chatgpt-export.js';
import { runPushCycle } from '../core/sync-push-client.js';
import { runPullCycle } from '../core/sync-pull-client.js';
import { createApp } from './app.js';

const PROJECTS_ROOT = process.env.SYNC_HUB_PROJECTS_ROOT ?? join(homedir(), 'Projets');
const DATA_DIR = process.env.SYNC_HUB_DATA_DIR ?? join(import.meta.dirname, '..', '..', 'data');
const IMPORTS_DIR = process.env.SYNC_HUB_IMPORTS_DIR ?? join(import.meta.dirname, '..', '..', 'imports');
const CLIENT_DIST = join(import.meta.dirname, '..', '..', 'dist', 'client');
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '127.0.0.1'; // local-only by default — this is a personal tool, not a network service

// A remote hub (brick 1 of remote sync — see the sync-hub plan) is this exact same server, just
// with nothing local to scan: no ~/.claude, no ~/Projets, inside its container. Same codebase,
// one flag, rather than a second image to build and keep in sync.
const DISABLE_LOCAL_INGEST = process.env.SYNC_HUB_DISABLE_LOCAL_INGEST === '1';
// Configures the OUTGOING/INCOMING sync side (this instance synchronizing with a remote hub) — opt-in, no-op on any
// instance that hasn't set both.
const REMOTE_URL = process.env.SYNC_HUB_REMOTE_URL;
const REMOTE_TOKEN = process.env.SYNC_HUB_REMOTE_TOKEN;

const db = new Db(join(DATA_DIR, 'hub.sqlite'));
const registry = new ProjectRegistry(db);
if (!DISABLE_LOCAL_INGEST) registry.bootstrapFromProjectsRoot(PROJECTS_ROOT);

function fullScan(): void {
  if (DISABLE_LOCAL_INGEST) return;
  claudeCode.ingestAll(db, registry);
  codex.ingestAll(db, registry);
  cowork.ingestAll(db, registry);
  antigravity.ingestAll(db, registry);
  ingestAllMemories(db, registry);
  ingestClaudeExport(db, join(IMPORTS_DIR, 'claude'));
  ingestChatGptExport(db, join(IMPORTS_DIR, 'chatgpt'));
  updateAllPointerFiles(db);
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncInterval: ReturnType<typeof setInterval> | undefined;

async function syncNow(): Promise<void> {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  try {
    // Pull any new remote items first, then push any pending local items
    await runPullCycle(db, { remoteUrl: REMOTE_URL, remoteToken: REMOTE_TOKEN });
    await runPushCycle(db, { remoteUrl: REMOTE_URL, remoteToken: REMOTE_TOKEN });
  } catch (err) {
    console.error('sync: bidirectional cycle failed', err);
  }
}

/** Debounced rather than fired on every ingest event — a burst of file changes (a full scan, a
 * fast-typed conversation) should settle into one sync cycle, not one HTTP round trip per file. */
function scheduleSync(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 15_000);
}

/** A floor under the ingest-driven schedule above. Guarantees regular pull/push even without local activity. */
function startSyncInterval(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  syncInterval = setInterval(syncNow, 5 * 60_000);
  syncInterval.unref?.(); // never hold the process open on its own account
}

if (DISABLE_LOCAL_INGEST) {
  console.log('sync-hub: rôle hub distant — pas de scan local, en attente de sync…');
} else {
  console.log('sync-hub: scan initial en cours (peut prendre 15-20s la première fois)…');
}
fullScan();
scheduleSync();
startSyncInterval();

const watchHandle: WatchHandle = DISABLE_LOCAL_INGEST
  ? { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} }
  : startWatching(db, registry, {
      onIngest: () => {
        updateAllPointerFiles(db);
        scheduleSync();
      },
    });

const app = createApp({
  db,
  registry,
  watchHandle,
  rescan: fullScan,
  clientDistDir: CLIENT_DIST,
  archiveRoots: { syncHubArchiveRoot: join(DATA_DIR, 'archived-sessions') },
  importsDir: IMPORTS_DIR,
  remoteUrl: REMOTE_URL,
  remoteToken: REMOTE_TOKEN,
});

const address = await app.listen({ port: PORT, host: HOST });
app.log.info(`sync-hub écoute sur ${address}`);

async function shutdown(): Promise<void> {
  if (syncTimer) clearTimeout(syncTimer);
  if (syncInterval) clearInterval(syncInterval);
  await watchHandle.close();
  await app.close();
  db.close();
  process.exit(0);
}

// SIGINT: Ctrl-C in a terminal. SIGTERM: what `launchctl unload`/`kill` send to stop the service.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
