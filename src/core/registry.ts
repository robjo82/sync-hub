import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';
import { UNASSIGNED_PROJECT_ID, type ProjectAliases } from '../types.js';

/** Mirrors Claude Code's own slugging algorithm: absolute path with every "/" turned into "-". */
export function pathToClaudeSlug(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function emptyAliases(): ProjectAliases {
  return { paths: [], claudeSlugs: [], codexCwds: [] };
}

/**
 * Maps a session's native identifiers (cwd, Claude Code slug, filesystem path) to a stable
 * project id. Every resolution queries the DB directly (no in-memory index to go stale) —
 * cheap at the scale of a few dozen projects, and it means a project inserted through any path
 * (bootstrap, direct db.upsertProject, a future "create project" API call) is immediately
 * resolvable without a separate reindex step to remember. Only exact matches resolve — anything
 * else falls into the "unassigned" bucket instead of being guessed, so a thread is never
 * silently misfiled.
 */
export class ProjectRegistry {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.ensureUnassignedProject();
  }

  private ensureUnassignedProject(): void {
    if (this.db.getProject(UNASSIGNED_PROJECT_ID)) return;
    const now = new Date().toISOString();
    this.db.upsertProject({
      id: UNASSIGNED_PROJECT_ID,
      name: 'Non affecté',
      canonicalPath: '',
      aliases: emptyAliases(),
      createdAt: now,
      lastActiveAt: now,
    });
  }

  /** Scans immediate subdirectories of `projectsRoot` and registers one project per folder. */
  bootstrapFromProjectsRoot(projectsRoot: string): void {
    let entries: string[];
    try {
      entries = readdirSync(projectsRoot);
    } catch {
      return;
    }
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(projectsRoot, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      const id = `proj-${slugifyName(entry)}`;
      if (this.db.getProject(id)) continue; // don't clobber aliases learned since bootstrap
      // canonical_path is UNIQUE — a project can already claim this exact folder under a
      // different id (e.g. manually repointed after moving a project into this root), in which
      // case creating a second row for the same path would crash the whole daemon on every scan.
      if (this.db.getProjects().some((p) => p.canonicalPath === fullPath)) continue;
      const aliases = emptyAliases();
      aliases.claudeSlugs.push(pathToClaudeSlug(fullPath));
      aliases.codexCwds.push(fullPath);
      this.db.upsertProject({
        id,
        name: entry,
        canonicalPath: fullPath,
        aliases,
        createdAt: now,
        lastActiveAt: now,
      });
    }
  }

  resolveByClaudeSlug(slug: string): string {
    for (const project of this.db.getProjects()) {
      if (project.aliases.claudeSlugs.includes(slug)) return project.id;
    }
    return UNASSIGNED_PROJECT_ID;
  }

  resolveByCodexCwd(cwd: string): string {
    for (const project of this.db.getProjects()) {
      if (project.aliases.codexCwds.includes(cwd) || project.canonicalPath === cwd || project.aliases.paths.includes(cwd)) {
        return project.id;
      }
    }
    return UNASSIGNED_PROJECT_ID;
  }

  resolveByPath(path: string): string {
    for (const project of this.db.getProjects()) {
      if (project.canonicalPath === path || project.aliases.paths.includes(path)) return project.id;
    }
    return UNASSIGNED_PROJECT_ID;
  }

  /**
   * Used by the "triage" dashboard view: teach the registry a new mapping so future sessions
   * auto-resolve. Deliberately excludes `chatgptProjectIds` — that alias is only ever populated by
   * a whole-project merge (db.mergeProjects), never assigned one value at a time.
   */
  assign(projectId: string, kind: Exclude<keyof ProjectAliases, 'chatgptProjectIds'>, value: string): void {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!project.aliases[kind].includes(value)) {
      project.aliases[kind].push(value);
      project.lastActiveAt = new Date().toISOString();
      this.db.upsertProject(project);
    }
  }
}
