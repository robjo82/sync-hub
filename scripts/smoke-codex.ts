import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import { discoverSessionFiles, ingestAll } from '../src/core/adapters/codex.js';
import { UNASSIGNED_PROJECT_ID } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'sync-hub-smoke-codex-'));
const db = new Db(join(dir, 'hub.sqlite'));
const registry = new ProjectRegistry(db);
registry.bootstrapFromProjectsRoot(join(process.env.HOME!, 'Projets'));

const refs = discoverSessionFiles();
console.log(`${refs.length} fichier(s) de session Codex découvert(s).`);

const start = Date.now();
const inserted = ingestAll(db, registry);
console.log(`${inserted} message(s) ingéré(s) au total en ${Date.now() - start}ms.`);

for (const project of db.getProjects()) {
  const threadCount = db.countThreadsForProject(project.id);
  if (threadCount === 0) continue;
  console.log(`- ${project.name} (${project.id}): ${threadCount} thread(s)`);
}
console.log(`Non affecté: ${db.countThreadsForProject(UNASSIGNED_PROJECT_ID)} thread(s)`);

const errors = db.raw.prepare("SELECT file_path, message FROM ingest_log WHERE status = 'error' AND engine = 'codex'").all();
console.log(`${errors.length} erreur(s) d'ingestion.`);
if (errors.length) console.log(errors.slice(0, 5));

db.close();
rmSync(dir, { recursive: true, force: true });
