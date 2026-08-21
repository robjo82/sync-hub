import { basename } from 'node:path';
import type { Db } from './db.js';
import type { ProjectRegistry } from './registry.js';
import * as claudeCode from './adapters/claude-code.js';
import * as codex from './adapters/codex.js';
import * as antigravity from './adapters/antigravity.js';

// Codex's own SessionFileRef carries only a filePath — the session id lives inside the file
// (first line, session_meta.payload.id), normally requiring a read. But Codex also embeds that
// same uuid as the filename's trailing segment (rollout-<timestamp>-<uuid>.jsonl, verified against
// real files) — pulling it from there avoids opening any non-matching file, which matters here:
// real Codex rollout files range up to ~500MB, and reading one fully just to check its id would
// undermine the whole point of a "targeted" ingest.
const CODEX_FILENAME_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function codexSessionIdFromFilename(filePath: string): string | undefined {
  return CODEX_FILENAME_UUID.exec(basename(filePath))?.[1];
}

/**
 * Looks for exactly one still-unseen session file whose native session id matches `threadId`,
 * across the three engines that write live, growing session files (Claude Code, Codex,
 * Antigravity — not the one-shot Claude.ai/ChatGPT exports, which never appear mid-write), and
 * ingests only that one file if found. Closes a real race observed in production: a tool calls
 * link_threads with its OWN thread's id moments after its first message, before the periodic
 * full scan or the watcher has picked it up — 17 of 28 real link_threads calls failed with
 * "unknown thread id" for exactly this reason (verified against mcp_call_log), most of them
 * never retried and so never actually linked.
 *
 * Deliberately targeted rather than a full rescan: discoverSessionFiles is a plain directory
 * listing (~0.2s across the whole real corpus, measured), whereas a full rescan re-reads and
 * re-hashes every message in every session file (~25s measured on the real store) — far too slow
 * to run synchronously inside a single tool call.
 */
export interface IngestSingleRoots {
  claudeCodeRoot?: string;
  codexRoots?: string[];
  antigravityRoot?: string;
}

export function tryIngestMissingThread(db: Db, registry: ProjectRegistry, threadId: string, roots: IngestSingleRoots = {}): boolean {
  if (db.getThread(threadId)) return true;

  const claudeRefs = roots.claudeCodeRoot ? claudeCode.discoverSessionFiles(roots.claudeCodeRoot) : claudeCode.discoverSessionFiles();
  const claudeRef = claudeRefs.find((r) => r.sessionId === threadId);
  if (claudeRef) {
    claudeCode.ingestSessionFile(db, registry, claudeRef);
    return !!db.getThread(threadId);
  }

  const codexRefs = roots.codexRoots ? codex.discoverSessionFiles(roots.codexRoots) : codex.discoverSessionFiles();
  const codexRef = codexRefs.find((r) => codexSessionIdFromFilename(r.filePath) === threadId);
  if (codexRef) {
    codex.ingestSessionFile(db, registry, codexRef);
    return !!db.getThread(threadId);
  }

  const antigravityRefs = roots.antigravityRoot ? antigravity.discoverSessionFiles(roots.antigravityRoot) : antigravity.discoverSessionFiles();
  const antigravityRef = antigravityRefs.find((r) => r.sessionId === threadId);
  if (antigravityRef) {
    antigravity.ingestSessionFile(db, registry, antigravityRef);
    return !!db.getThread(threadId);
  }

  return false;
}
