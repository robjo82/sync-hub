import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { discoverSessionFiles, ingestAll } from '../src/core/adapters/claude-code.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'sync-hub-smoke-'));
const db = new Db(join(dir, 'hub.sqlite'));
const registry = new ProjectRegistry(db);
registry.bootstrapFromProjectsRoot(join(process.env.HOME!, 'Projets'));

const refs = discoverSessionFiles();
console.log(`${refs.length} fichier(s) de session Claude Code découvert(s).`);

const inserted = ingestAll(db, registry);
console.log(`${inserted} message(s) ingéré(s) au total.`);

for (const project of db.getProjects()) {
  const threadCount = db.countThreadsForProject(project.id);
  if (threadCount === 0) continue;
  console.log(`- ${project.name} (${project.id}): ${threadCount} thread(s)`);
}

const unassignedThreads = db.countThreadsForProject(UNASSIGNED_PROJECT_ID);
console.log(`Non affecté: ${unassignedThreads} thread(s)`);

db.close();
rmSync(dir, { recursive: true, force: true });
