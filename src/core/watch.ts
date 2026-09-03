import chokidar, { type FSWatcher } from 'chokidar';
import { statSync } from 'node:fs';
import type { Db } from './db.js';
import type { ProjectRegistry } from './registry.js';
import * as claudeCode from './adapters/claude-code.js';
import * as codex from './adapters/codex.js';
import * as antigravity from './adapters/antigravity.js';
import type { EngineType } from '../types.js';

export interface WatchHandle {
  close(): Promise<void>;
  isActive(): boolean;
  /** Resolves once the initial directory scan is done and new files will start producing events. */
  ready(): Promise<void>;
}

interface WatchOptions {
  onIngest?: (event: { engine: EngineType; filePath: string; inserted: number }) => void;
  /** Override the watched roots (used by tests; production callers should rely on the defaults). */
  claudeCodeRoot?: string;
  codexRoots?: string[];
  antigravityRoots?: string[];
  /**
   * Force the polling backend. Defaults to polling under vitest (deterministic, and fsevents
   * proved flaky under concurrent workers) and to native fsevents everywhere else, where polling
   * costs ~300× more CPU for the same result.
   */
  usePolling?: boolean;
}

/**
 * Live-tails a growing JSONL file: reads only the bytes appended since the last time we saw it
 * (tracked in-memory per absolute path). A fresh process starts with nothing recorded, which just
 * re-triggers a full scan of each file on restart — safe and cheap, because the hash-uniqueness
 * gate in Db.insertMessage makes that idempotent.
 *
 * Tailing is only attempted when the file is provably the same one, grown. Anything else — a
 * shrink, a new inode — re-reads from the start, because an offset that no longer matches the
 * file silently skips content instead of failing loudly.
 */
function startEngineWatch(
  engine: EngineType,
  roots: string[],
  db: Db,
  registry: ProjectRegistry,
  opts: WatchOptions,
): FSWatcher {
  // Keyed by absolute path: the size we last consumed, plus the inode we saw it on. Both are
  // needed to decide whether the next event is a plain append or a file that was replaced.
  const seen = new Map<string, { size: number; ino: number }>();

  const ingest = (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    let size: number;
    let ino: number;
    try {
      const st = statSync(filePath);
      size = st.size;
      ino = st.ino;
    } catch {
      return;
    }
    const previous = seen.get(filePath);
    // Tail from the last offset only when this is provably the same file, grown. A smaller size
    // means it was truncated or rewritten; a different inode means it was replaced outright
    // (rename-into-place, rotation). In both cases the recorded offset points into content that
    // no longer exists there, so re-read from the start — insertMessage's hash gate makes the
    // repeat free, whereas tailing from a stale offset loses everything before it, permanently.
    const isAppend = previous !== undefined && previous.ino === ino && size >= previous.size;
    const fromOffset = isAppend ? previous.size : undefined;
    let inserted = 0;
    if (engine === 'claude-code') {
      inserted = claudeCode.ingestSessionFile(db, registry, claudeCode.refFromFilePath(filePath), fromOffset ? { fromOffset } : {});
    } else if (engine === 'codex') {
      inserted = codex.ingestSessionFile(db, registry, { filePath }, fromOffset ? { fromOffset } : {});
    } else {
      // Antigravity's brain/ tree holds many non-transcript files per session (steps, scratch,
      // uploads) — refFromFilePath returns null for anything but transcript_full.jsonl so those
      // don't get misread as a session file.
      const ref = antigravity.refFromFilePath(filePath);
      if (!ref) return;
      inserted = antigravity.ingestSessionFile(db, registry, ref, fromOffset ? { fromOffset } : {});
    }
    seen.set(filePath, { size, ino });
    if (inserted > 0) opts.onIngest?.({ engine, filePath, inserted });
  };

  // chokidar v4 dropped glob support — watch the root directories directly (recursive by default)
  // and reject anything that is not a transcript here, in `ignored`, rather than only inside
  // `ingest`. Same outcome, vastly less work: on this machine the roots hold 4 062 files of which
  // 588 are .jsonl, the rest being Antigravity's per-session steps, scratch and uploads. Watching
  // them only to discard them later cost 85% of the watcher's work.
  //
  // Polling is kept for tests, where the native fsevents backend proved unreliable under
  // concurrent worker load (events never firing within any timeout), and it is deterministic.
  // In production it is not "cheap enough" as this once assumed: measured on the real roots,
  // polling every 300ms burns 30.7% of a core continuously, against 0.1% for fsevents — some
  // 17 000 stat() calls a second, forever, on an idle machine.
  const usePolling = opts.usePolling ?? !!process.env.VITEST;
  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    // stats is undefined until chokidar has stat'd the entry; never ignore then, or the entry is
    // dropped before it can be identified. Directories must stay watched to be descended into.
    ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl'),
    ...(usePolling
      ? { usePolling: true, interval: 300, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } }
      : { usePolling: false, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } }),
  });
  watcher.on('add', ingest).on('change', ingest);
  if (process.env.SYNC_HUB_WATCH_DEBUG) {
    watcher.on('error', (err) => console.error(`[watch:${engine}] error`, err));
    watcher.on('all', (event, path) => console.error(`[watch:${engine}] ${event} ${path}`));
  }
  return watcher;
}

export function startWatching(db: Db, registry: ProjectRegistry, opts: WatchOptions = {}): WatchHandle {
  const claudeCodeRoot = opts.claudeCodeRoot ?? claudeCode.CLAUDE_CODE_STORAGE_ROOT;
  const codexRoots = opts.codexRoots ?? [codex.CODEX_SESSIONS_ROOT, codex.CODEX_ARCHIVED_SESSIONS_ROOT];
  const antigravityRoots = opts.antigravityRoots ?? [antigravity.ANTIGRAVITY_BRAIN_ROOT, antigravity.ANTIGRAVITY_CLI_BRAIN_ROOT];
  const watchers: FSWatcher[] = [
    startEngineWatch('claude-code', [claudeCodeRoot], db, registry, opts),
    startEngineWatch('codex', codexRoots, db, registry, opts),
    startEngineWatch('antigravity', antigravityRoots, db, registry, opts),
  ];
  const readyPromise = Promise.all(watchers.map((w) => new Promise<void>((resolve) => w.once('ready', () => resolve())))).then(
    () => undefined,
  );
  let active = true;
  return {
    isActive: () => active,
    ready: () => readyPromise,
    close: async () => {
      active = false;
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
