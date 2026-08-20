import chokidar, { type FSWatcher } from 'chokidar';
import { statSync } from 'node:fs';
import type { Db } from './db.js';
import type { ProjectRegistry } from './registry.js';
import * as claudeCode from './adapters/claude-code.js';
import * as codex from './adapters/codex.js';
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
}

/**
 * Live-tails a growing JSONL file: reads only the bytes appended since the last time we saw it
 * (tracked in-memory by byte offset, per absolute path). A fresh process starts every offset at
 * 0, which just re-triggers a full scan of each file on restart — safe and cheap, because the
 * hash-uniqueness gate in Db.insertMessage makes that idempotent.
 */
function startEngineWatch(
  engine: EngineType,
  roots: string[],
  db: Db,
  registry: ProjectRegistry,
  opts: WatchOptions,
): FSWatcher {
  const offsets = new Map<string, number>();

  const ingest = (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    const fromOffset = offsets.get(filePath);
    let inserted = 0;
    if (engine === 'claude-code') {
      inserted = claudeCode.ingestSessionFile(db, registry, claudeCode.refFromFilePath(filePath), fromOffset ? { fromOffset } : {});
    } else {
      inserted = codex.ingestSessionFile(db, registry, { filePath }, fromOffset ? { fromOffset } : {});
    }
    offsets.set(filePath, size);
    if (inserted > 0) opts.onIngest?.({ engine, filePath, inserted });
  };

  // chokidar v4 dropped glob support — watch the root directories directly (recursive by
  // default) and filter to .jsonl inside `ingest` instead of relying on a glob pattern.
  // usePolling avoids the native fsevents backend, which proved unreliable under concurrent
  // test-worker load (events never firing within any timeout) — polling is deterministic and,
  // for a handful of locally-watched files, cheap enough to always prefer.
  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    usePolling: true,
    interval: 300,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
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
  const watchers: FSWatcher[] = [
    startEngineWatch('claude-code', [claudeCodeRoot], db, registry, opts),
    startEngineWatch('codex', codexRoots, db, registry, opts),
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
