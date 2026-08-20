import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from './db.js';
import { CODEX_ARCHIVED_SESSIONS_ROOT } from './adapters/codex.js';
import type { Project, Thread } from '../types.js';

export interface ArchiveRoots {
  syncHubArchiveRoot: string;
  /** Defaults to the real ~/.codex/archived_sessions — override in tests to avoid touching the real home directory. */
  codexArchiveRoot?: string;
}

export interface ArchiveResult {
  ok: boolean;
  movedFileTo?: string;
  note: string;
}

/**
 * Archives a thread by MOVING (never deleting) its real source session file to an archive
 * location, then marking it archived in sync-hub's own store. Codex already has a native
 * archived_sessions/ folder — mirrored exactly, so this matches what Codex's own archive
 * feature does. Claude Code has no equivalent, so its file moves into a sync-hub-managed
 * archive directory instead: out of Claude Code's active project list, never destroyed.
 * Threads with no real source file (bulk-imported, or the file has already vanished) are
 * archived sync-hub-side only — there is nothing on disk to move.
 */
export function archiveThread(db: Db, thread: Thread, opts: ArchiveRoots): ArchiveResult {
  if (thread.status === 'archived') {
    return { ok: true, note: 'Déjà archivé.' };
  }

  const codexArchiveRoot = opts.codexArchiveRoot ?? CODEX_ARCHIVED_SESSIONS_ROOT;
  let movedFileTo: string | undefined;
  let note: string;

  if (!thread.sourceFilePath || !existsSync(thread.sourceFilePath)) {
    note = "Aucun fichier source à déplacer (session importée, ou fichier déjà absent) — archivage côté sync-hub uniquement.";
  } else if (thread.originEngine === 'codex') {
    const dest = join(codexArchiveRoot, basename(thread.sourceFilePath));
    if (thread.sourceFilePath === dest) {
      note = 'Déjà dans ~/.codex/archived_sessions/.';
    } else {
      try {
        mkdirSync(codexArchiveRoot, { recursive: true });
        renameSync(thread.sourceFilePath, dest);
        movedFileTo = dest;
        note = `Fichier déplacé vers l'archive native de Codex (${dest}).`;
      } catch (err: any) {
        note = `Échec du déplacement (${err.message}) — archivage côté sync-hub uniquement.`;
      }
    }
  } else if (thread.originEngine === 'claude-code') {
    const dest = join(opts.syncHubArchiveRoot, 'claude-code', basename(thread.sourceFilePath));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(thread.sourceFilePath, dest);
      movedFileTo = dest;
      note = `Claude Code n'a pas d'archive native — fichier déplacé hors de sa liste de sessions actives, vers l'archive sync-hub (${dest}). Récupérable, jamais supprimé.`;
    } catch (err: any) {
      note = `Échec du déplacement (${err.message}) — archivage côté sync-hub uniquement.`;
    }
  } else {
    note = 'Moteur non pris en charge pour le déplacement du fichier source — archivage côté sync-hub uniquement.';
  }

  db.setThreadStatus(thread.id, 'archived');
  if (movedFileTo) {
    db.upsertThread({ ...thread, sourceFilePath: movedFileTo, status: 'archived' });
  }

  return { ok: true, movedFileTo, note };
}

/**
 * Removes a thread from sync-hub's own store entirely (not just hidden, like archiveThread —
 * actually gone from the dashboard/DB). The real source file gets the exact same safe treatment
 * as archiveThread first (moved aside, never deleted) so a later full scan can't silently
 * re-ingest it and undo the deletion.
 */
export function deleteThread(db: Db, thread: Thread, opts: ArchiveRoots): ArchiveResult {
  const { movedFileTo, note } = archiveThread(db, thread, opts);
  db.deleteThread(thread.id);
  return { ok: true, movedFileTo, note: `${note} Fil retiré de sync-hub.` };
}

export interface DeleteProjectResult {
  ok: boolean;
  movedFolderTo?: string;
  note: string;
}

/**
 * "Delete" a project by MOVING its real folder to the macOS Trash (never `rm -rf`) and removing
 * it from sync-hub's own store. Trash is genuinely recoverable — via Finder, or `mv` back — until
 * the user empties it themselves; that's a deliberate line sync-hub never crosses on its own,
 * even when explicitly asked to delete "completely".
 */
export function deleteProject(db: Db, project: Project, opts: { trashRoot?: string } = {}): DeleteProjectResult {
  const trashRoot = opts.trashRoot ?? join(homedir(), '.Trash');
  let movedFolderTo: string | undefined;
  let note: string;

  if (!project.canonicalPath || !existsSync(project.canonicalPath)) {
    note = 'Aucun dossier de projet à déplacer (déjà absent, ou projet sans dossier réel).';
  } else {
    try {
      mkdirSync(trashRoot, { recursive: true });
      let dest = join(trashRoot, basename(project.canonicalPath));
      if (existsSync(dest)) dest = join(trashRoot, `${basename(project.canonicalPath)}-${Date.now()}`);
      renameSync(project.canonicalPath, dest);
      movedFolderTo = dest;
      note = `Dossier déplacé vers la Corbeille (${dest}) — récupérable tant qu'elle n'est pas vidée.`;
    } catch (err: any) {
      return { ok: false, note: `Échec du déplacement du dossier (${err.message}) — rien n'a été modifié.` };
    }
  }

  db.deleteProject(project.id);
  return { ok: true, movedFolderTo, note };
}
