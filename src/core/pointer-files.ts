import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';
import type { EngineType, Project } from '../types.js';

const BEGIN_MARKER = '<!-- sync-hub:begin -->';
const END_MARKER = '<!-- sync-hub:end -->';
const ENGINE_LABEL: Record<EngineType, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

function formatRelative(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

function buildSummaryLine(db: Db, project: Project, now: Date): string {
  const lastByEngine = db.getLastActivityByEngine(project.id);
  const entries = (Object.entries(lastByEngine) as [EngineType, string][]).sort((a, b) => (a[1] < b[1] ? 1 : -1));
  if (entries.length === 0) {
    return 'Aucune activité multi-outils enregistrée pour ce projet pour le moment.';
  }
  const parts = entries.map(([engine, at]) => `${ENGINE_LABEL[engine] ?? engine} ${formatRelative(at, now)}`);
  return `Dernière activité multi-outils sur ce projet — ${parts.join(' · ')}.`;
}

function buildBlock(summary: string): string {
  return (
    `${BEGIN_MARKER}\n` +
    `**Sync-hub** — ${summary} Interroge le serveur MCP \`sync-hub\` ` +
    '(`get_project_timeline`, `search_transcripts`) pour consulter le détail verbatim des échanges dans les autres outils ' +
    "avant de repartir de zéro sur un sujet déjà traité ailleurs. Si ce fil est la suite d'un travail commencé dans un " +
    'autre outil, lie-le avec `link_threads` (une fois), puis appelle `get_thread_link_updates` en début de tour tant que ' +
    "le fil est actif — ça renvoie uniquement ce qui s'est passé de nouveau ailleurs dans le groupe, jamais tout " +
    "l'historique à chaque fois.\n" +
    `${END_MARKER}`
  );
}

/** Idempotently replaces (or appends) a single managed block, leaving the rest of the file untouched. */
function upsertBlock(filePath: string, block: string): void {
  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
  }
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    writeFileSync(filePath, `${before}${block}${after}`);
  } else {
    const separator = existing.trim().length ? '\n\n' : '';
    writeFileSync(filePath, `${existing}${separator}${block}\n`);
  }
}

/**
 * Keeps a one-line, factual pointer up to date in each project's CLAUDE.md and AGENTS.md —
 * never a content summary, just "something happened elsewhere, go look" plus how to look.
 * Skipped for the sentinel "unassigned" project (no canonical path to write into), and skipped
 * — rather than throwing — for a project whose canonical path no longer exists on disk (moved
 * or deleted since the registry last saw it); that's a registry-staleness issue to surface in
 * the dashboard, not something that should crash whatever triggered this call.
 */
export function updatePointerFiles(db: Db, project: Project, now: Date = new Date()): void {
  if (!project.canonicalPath || !existsSync(project.canonicalPath)) return;
  const block = buildBlock(buildSummaryLine(db, project, now));
  upsertBlock(join(project.canonicalPath, 'CLAUDE.md'), block);
  upsertBlock(join(project.canonicalPath, 'AGENTS.md'), block);
}

export function updateAllPointerFiles(db: Db, now: Date = new Date()): void {
  for (const project of db.getProjects()) {
    updatePointerFiles(db, project, now);
  }
}
