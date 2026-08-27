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
// Configures the OUTGOING side (this instance pushing to a remote hub) — opt-in, no-op on any
// instance that hasn't set both. Never set on the remote hub itself; it only ever receives.
const REMOTE_URL = process.env.SYNC_HUB_REMOTE_URL;
const REMOTE_TOKEN = process.env.SYNC_HUB_REMOTE_TOKEN;
// Configures the INCOMING side (this instance accepting POST /api/sync/push from others) — reuses
// the same var name as the outgoing token since a real deployment only ever needs one of the two
// roles active, never both, so there's no real ambiguity in sharing the name.

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

let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pushInterval: ReturnType<typeof setInterval> | undefined;

function pushNow(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  runPushCycle(db, { remoteUrl: REMOTE_URL, remoteToken: REMOTE_TOKEN }).catch((err) => console.error('sync-push: cycle failed', err));
}

/** Debounced rather than fired on every ingest event — a burst of file changes (a full scan, a
 * fast-typed conversation) should settle into one push cycle, not one HTTP round trip per file. */
function schedulePush(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 15_000);
}

/** A floor under the ingest-driven schedule above. A cycle that fails (remote redeploying, network
 * blip) leaves its watermark untouched and waits for "next cycle" — but the only thing that used to
 * start one was a local ingest event, so on a quiet machine a single failed push could stall the
 * sync for hours. This guarantees a retry regardless of local activity. */
function startPushInterval(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  pushInterval = setInterval(pushNow, 5 * 60_000);
  pushInterval.unref?.(); // never hold the process open on its own account
}

if (DISABLE_LOCAL_INGEST) {
  console.log('sync-hub: rôle hub distant — pas de scan local, en attente de POST /api/sync/push…');
} else {
  console.log('sync-hub: scan initial en cours (peut prendre 15-20s la première fois)…');
}
fullScan();
schedulePush();
startPushInterval();

const watchHandle: WatchHandle = DISABLE_LOCAL_INGEST
  ? { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} }
  : startWatching(db, registry, {
      onIngest: () => {
        updateAllPointerFiles(db);
        schedulePush();
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
  remoteToken: REMOTE_TOKEN,
});

const address = await app.listen({ port: PORT, host: HOST });
app.log.info(`sync-hub écoute sur ${address}`);

async function shutdown(): Promise<void> {
  if (pushTimer) clearTimeout(pushTimer);
  if (pushInterval) clearInterval(pushInterval);
  await watchHandle.close();
  await app.close();
  db.close();
  process.exit(0);
}

// SIGINT: Ctrl-C in a terminal. SIGTERM: what `launchctl unload`/`kill` send to stop the service.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
