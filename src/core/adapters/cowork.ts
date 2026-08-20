import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import * as claudeCode from './claude-code.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';

export const COWORK_SESSIONS_ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');

interface CoworkSessionDir {
  configPath: string;
  sessionDir: string;
}

/**
 * Each Cowork session is a `local_<uuid>.json` config file next to a `local_<uuid>/` directory
 * that runs an actual Claude Code instance inside its sandboxed VM — its `.claude/projects/`
 * subtree uses the exact same JSONL schema our regular adapter already parses.
 */
function discoverCoworkSessionDirs(root: string = COWORK_SESSIONS_ROOT): CoworkSessionDir[] {
  if (!existsSync(root)) return [];
  const out: CoworkSessionDir[] = [];
  for (const account of readdirSync(root)) {
    const accountDir = join(root, account);
    let workspaces: string[];
    try {
      workspaces = readdirSync(accountDir).filter((w) => statSync(join(accountDir, w)).isDirectory());
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      const workspaceDir = join(accountDir, workspace);
      let entries: string[];
      try {
        entries = readdirSync(workspaceDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith('local_') || !entry.endsWith('.json')) continue;
        const sessionDir = join(workspaceDir, entry.slice(0, -'.json'.length));
        if (existsSync(sessionDir)) {
          out.push({ configPath: join(workspaceDir, entry), sessionDir });
        }
      }
    }
  }
  return out;
}

export function storageRootExists(root: string = COWORK_SESSIONS_ROOT): boolean {
  return existsSync(root);
}

/**
 * Resolves the real project via the folder(s) the user attached to the Cowork session
 * (`userSelectedFolders`) — the VM's own `cwd` is always a sandboxed path and carries no
 * usable project signal. Sessions with no attached folder land in "unassigned" for triage,
 * same as any other unmatched source, rather than being guessed.
 */
export function ingestAll(db: Db, registry: ProjectRegistry, root: string = COWORK_SESSIONS_ROOT): number {
  let total = 0;
  for (const { configPath, sessionDir } of discoverCoworkSessionDirs(root)) {
    let config: any;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }
    const folders: string[] = Array.isArray(config.userSelectedFolders) ? config.userSelectedFolders : [];
    const projectIdOverride = folders.length > 0 ? registry.resolveByPath(folders[0]) : UNASSIGNED_PROJECT_ID;

    const claudeProjectsRoot = join(sessionDir, '.claude', 'projects');
    for (const ref of claudeCode.discoverSessionFiles(claudeProjectsRoot)) {
      total += claudeCode.ingestSessionFile(db, registry, ref, { projectIdOverride });
    }
  }
  return total;
}
