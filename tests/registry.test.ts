import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry, pathToClaudeSlug } from '../src/core/registry.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-registry-'));
  db = new Db(join(dir, 'hub.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pathToClaudeSlug', () => {
  it('mirrors Claude Code\'s own slug algorithm (every "/" becomes "-")', () => {
    expect(pathToClaudeSlug('/Users/robin/Projets/odoo')).toBe('-Users-robin-Projets-odoo');
    expect(pathToClaudeSlug('/Users/robin')).toBe('-Users-robin');
  });
});

describe('ProjectRegistry', () => {
  it('bootstraps one project per immediate subdirectory, with correct aliases', () => {
    const projectsRoot = join(dir, 'Projets');
    mkdirSync(join(projectsRoot, 'odoo'), { recursive: true });
    mkdirSync(join(projectsRoot, 'sync-hub'), { recursive: true });

    const registry = new ProjectRegistry(db);
    registry.bootstrapFromProjectsRoot(projectsRoot);

    const projects = db.getProjects().filter((p) => p.id !== UNASSIGNED_PROJECT_ID);
    expect(projects).toHaveLength(2);

    const odoo = db.getProject('proj-odoo');
    expect(odoo?.canonicalPath).toBe(join(projectsRoot, 'odoo'));
    expect(odoo?.aliases.claudeSlugs).toContain(pathToClaudeSlug(join(projectsRoot, 'odoo')));
    expect(odoo?.aliases.codexCwds).toContain(join(projectsRoot, 'odoo'));
  });

  it('resolves an exact Claude slug match, never guesses on partial matches', () => {
    const projectsRoot = join(dir, 'Projets');
    mkdirSync(join(projectsRoot, 'odoo'), { recursive: true });
    const registry = new ProjectRegistry(db);
    registry.bootstrapFromProjectsRoot(projectsRoot);

    expect(registry.resolveByClaudeSlug(pathToClaudeSlug(join(projectsRoot, 'odoo')))).toBe('proj-odoo');
    expect(registry.resolveByClaudeSlug('-Users-robin-Projets-odoo-something-else')).toBe(UNASSIGNED_PROJECT_ID);
    expect(registry.resolveByClaudeSlug('-Users-robin')).toBe(UNASSIGNED_PROJECT_ID);
  });

  it('lands unscoped/unmatched sessions in the unassigned bucket rather than guessing', () => {
    const registry = new ProjectRegistry(db);
    expect(registry.resolveByCodexCwd('/Users/robin/Documents/Codex/2026-08-14/some-adhoc-slug')).toBe(UNASSIGNED_PROJECT_ID);
    expect(db.getProject(UNASSIGNED_PROJECT_ID)?.name).toBe('Non affecté');
  });

  it('skips a folder whose canonical_path is already claimed by another project, instead of crashing — regression for a real incident (a project manually repointed to a folder later discovered by bootstrap)', () => {
    const projectsRoot = join(dir, 'Projets');
    mkdirSync(join(projectsRoot, 'accordeon'), { recursive: true });

    const now = new Date().toISOString();
    db.upsertProject({
      id: 'proj-accordeon-real',
      name: 'accordeon',
      canonicalPath: join(projectsRoot, 'accordeon'),
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: now,
      lastActiveAt: now,
    });

    const registry = new ProjectRegistry(db);
    expect(() => registry.bootstrapFromProjectsRoot(projectsRoot)).not.toThrow();

    // The manually-created project survives untouched — no duplicate "proj-accordeon" row.
    expect(db.getProject('proj-accordeon')).toBeUndefined();
    expect(db.getProject('proj-accordeon-real')?.canonicalPath).toBe(join(projectsRoot, 'accordeon'));
  });

  it('does not recreate a project whose folder was merged into another project (its path lives in the target\'s aliases.paths, not as anyone\'s canonical_path) — regression for a real find: iverif merged into MGX Controle kept reappearing on every rescan', () => {
    const projectsRoot = join(dir, 'Projets');
    mkdirSync(join(projectsRoot, 'iverif'), { recursive: true });

    const now = new Date().toISOString();
    db.upsertProject({
      id: 'chatgpt-project-g-p-mgx',
      name: 'C00063 - MGX Controle',
      canonicalPath: 'chatgpt-project://g-p-mgx', // not a real folder — merge only ever adds an alias here
      aliases: { paths: [join(projectsRoot, 'iverif')], claudeSlugs: [], codexCwds: [] },
      createdAt: now,
      lastActiveAt: now,
    });

    const registry = new ProjectRegistry(db);
    registry.bootstrapFromProjectsRoot(projectsRoot);

    expect(db.getProject('proj-iverif')).toBeUndefined();
    expect(db.getProject('chatgpt-project-g-p-mgx')?.aliases.paths).toContain(join(projectsRoot, 'iverif'));
  });

  it('assign() teaches the registry a new mapping so future lookups resolve', () => {
    const projectsRoot = join(dir, 'Projets');
    mkdirSync(join(projectsRoot, 'odoo'), { recursive: true });
    const registry = new ProjectRegistry(db);
    registry.bootstrapFromProjectsRoot(projectsRoot);

    expect(registry.resolveByCodexCwd('/Users/robin/Documents/Codex/2026-08-14/devis-appel-d-offres-odoo')).toBe(UNASSIGNED_PROJECT_ID);

    registry.assign('proj-odoo', 'codexCwds', '/Users/robin/Documents/Codex/2026-08-14/devis-appel-d-offres-odoo');

    expect(registry.resolveByCodexCwd('/Users/robin/Documents/Codex/2026-08-14/devis-appel-d-offres-odoo')).toBe('proj-odoo');
  });
});
