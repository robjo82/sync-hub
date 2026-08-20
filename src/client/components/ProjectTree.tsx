import { useEffect, useState } from 'react';
import type { Artifact, Memory, Project, Thread } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_DOT: Record<string, string> = { 'claude-code': 'bg-purple-500', codex: 'bg-emerald-500' };

export type SelectedItem = { kind: 'thread'; id: string } | { kind: 'memory'; item: Memory } | { kind: 'artifact'; item: Artifact } | null;

interface ProjectTreeProps {
  projects: Project[];
  selected: SelectedItem;
  onSelect: (item: SelectedItem) => void;
  refreshToken: number;
  onChanged: () => void;
}

interface ProjectChildren {
  threads: Thread[];
  memories: Memory[];
  artifacts: Artifact[];
}

function ArchiveButton({ title, onConfirm }: { title: string; onConfirm: () => void }) {
  return (
    <button
      title="Archiver"
      onClick={(e) => {
        e.stopPropagation();
        if (window.confirm(`Archiver « ${title} » ?\n\nLe fichier source est déplacé (jamais supprimé) hors de la liste active de son outil d'origine.`)) {
          onConfirm();
        }
      }}
      className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 hover:bg-slate-200 hover:text-amber-600 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-amber-400"
    >
      🗄
    </button>
  );
}

function RenameProjectButton({ project, onConfirm }: { project: Project; onConfirm: (name: string) => void }) {
  return (
    <button
      title="Renommer"
      onClick={(e) => {
        e.stopPropagation();
        const name = window.prompt('Nouveau nom du projet :', project.name)?.trim();
        if (name && name !== project.name) onConfirm(name);
      }}
      className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      ✏️
    </button>
  );
}

function MergeProjectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      title="Fusionner dans un autre projet"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 hover:bg-indigo-100 hover:text-indigo-600 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
    >
      🔗
    </button>
  );
}

/** Full-width picker for folding a project into another one — a pure DB reassignment
 * (threads/memories/artifacts move, aliases merge), never touches real files. Useful when the same
 * real project was independently discovered under two identities (e.g. a live Codex project and an
 * unrelated-looking ChatGPT Project that turns out to be the same client). Rendered as its own row
 * below the project title rather than squeezed inline — the sidebar is too narrow for a select full
 * of project names plus confirm/cancel buttons to fit next to the title and other icons. */
function MergeProjectPanel({
  project,
  otherProjects,
  onConfirm,
  onCancel,
}: {
  project: Project;
  otherProjects: Project[];
  onConfirm: (targetId: string) => void;
  onCancel: () => void;
}) {
  const [targetId, setTargetId] = useState('');

  return (
    <div className="mb-1 ml-5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <select
        autoFocus
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        className="w-0 min-w-0 flex-1 rounded border border-slate-300 bg-white px-1 py-0.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
      >
        <option value="">Fusionner dans…</option>
        {otherProjects
          .filter((p) => p.id !== project.id)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
      <button
        title="Confirmer la fusion"
        disabled={!targetId}
        onClick={() => {
          const target = otherProjects.find((p) => p.id === targetId);
          if (
            target &&
            window.confirm(
              `Fusionner « ${project.name} » dans « ${target.name} » ?\n\n` +
                `Tous les fils, mémoires et artefacts de « ${project.name} » sont déplacés vers « ${target.name} », qui conserve son nom. ` +
                `« ${project.name} » disparaît de la liste des projets. Aucun fichier réel n'est touché — uniquement les enregistrements sync-hub.`,
            )
          ) {
            onConfirm(targetId);
          } else {
            onCancel();
          }
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-indigo-600 hover:bg-indigo-100 disabled:opacity-40 dark:text-indigo-400 dark:hover:bg-indigo-950"
      >
        ✓
      </button>
      <button
        title="Annuler"
        onClick={onCancel}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-200 dark:text-slate-600 dark:hover:bg-slate-800"
      >
        ✕
      </button>
    </div>
  );
}

function DeleteProjectButton({ project, onConfirm }: { project: Project; onConfirm: () => void }) {
  return (
    <button
      title="Supprimer le projet (déplace le dossier vers la Corbeille)"
      onClick={(e) => {
        e.stopPropagation();
        const typed = window.prompt(
          `Supprimer complètement « ${project.name} » ?\n\n` +
            `Le dossier réel (${project.canonicalPath || 'aucun'}) est déplacé vers la Corbeille macOS — récupérable tant qu'elle n'est pas vidée, jamais supprimé pour de bon par sync-hub.\n\n` +
            `Tape le nom du projet pour confirmer :`,
        );
        if (typed === project.name) onConfirm();
        else if (typed !== null) window.alert("Nom incorrect — rien n'a été supprimé.");
      }}
      className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 hover:bg-red-100 hover:text-red-600 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-red-950 dark:hover:text-red-400"
    >
      🗑
    </button>
  );
}

function ProjectNode({
  project,
  allProjects,
  selected,
  onSelect,
  refreshToken,
  onChanged,
  draggable,
}: { project: Project; allProjects: Project[]; draggable: boolean } & Omit<ProjectTreeProps, 'projects'>) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ProjectChildren | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    Promise.all([api.threads(project.id), api.memories(project.id), api.artifacts(project.id)]).then(([threads, memories, artifacts]) =>
      setChildren({ threads, memories, artifacts }),
    );
  }, [expanded, project.id, refreshToken]);

  return (
    <div>
      <div className="group flex items-center rounded hover:bg-slate-100 dark:hover:bg-slate-900">
        {draggable && (
          <span
            title="Glisser pour réorganiser"
            className="shrink-0 cursor-grab px-1 text-slate-300 opacity-0 group-hover:opacity-100 dark:text-slate-700"
          >
            ⠿
          </span>
        )}
        <button onClick={() => setExpanded((e) => !e)} className="flex flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm text-slate-700 dark:text-slate-300">
          <span className="w-3 text-slate-400 dark:text-slate-500">{expanded ? '▾' : '▸'}</span>
          <span className="truncate">{project.name}</span>
        </button>
        <RenameProjectButton
          project={project}
          onConfirm={async (name) => {
            await api.renameProject(project.id, name);
            onChanged();
          }}
        />
        <MergeProjectButton onClick={() => setMerging(true)} />
        <ArchiveButton
          title={project.name}
          onConfirm={async () => {
            await api.archiveProject(project.id);
            onChanged();
          }}
        />
        <DeleteProjectButton
          project={project}
          onConfirm={async () => {
            await api.deleteProject(project.id);
            onChanged();
          }}
        />
      </div>
      {merging && (
        <MergeProjectPanel
          project={project}
          otherProjects={allProjects}
          onConfirm={async (targetId) => {
            setMerging(false);
            await api.mergeProject(project.id, targetId);
            onChanged();
          }}
          onCancel={() => setMerging(false)}
        />
      )}
      {expanded && children && (
        <div className="ml-5 border-l border-slate-200 pl-2 dark:border-slate-800">
          {children.threads.length === 0 && children.memories.length === 0 && children.artifacts.length === 0 && (
            <p className="px-2 py-1 text-xs text-slate-400 dark:text-slate-600">Rien pour l'instant.</p>
          )}
          {children.threads.map((t) => (
            <div key={t.id} className="group flex items-center rounded">
              <button
                onClick={() => onSelect({ kind: 'thread', id: t.id })}
                className={`flex flex-1 items-center gap-1.5 truncate px-2 py-1 text-left text-xs ${
                  selected?.kind === 'thread' && selected.id === t.id
                    ? 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900'
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ENGINE_DOT[t.originEngine] ?? 'bg-slate-400 dark:bg-slate-600'}`} />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-slate-400 dark:text-slate-600">{t.messageCount}</span>
              </button>
              <ArchiveButton
                title={t.title}
                onConfirm={async () => {
                  await api.archiveThread(t.id);
                  setChildren((c) => (c ? { ...c, threads: c.threads.filter((x) => x.id !== t.id) } : c));
                  onChanged();
                }}
              />
            </div>
          ))}
          {children.memories.map((m) => (
            <button
              key={m.id}
              onClick={() => onSelect({ kind: 'memory', item: m })}
              className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
            >
              <span>🧠</span>
              <span className="truncate">{m.filePath.split('/').pop()}</span>
            </button>
          ))}
          {children.artifacts.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect({ kind: 'artifact', item: a })}
              className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
            >
              <span>📄</span>
              <span className="truncate">{a.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectTree({ projects, selected, onSelect, refreshToken, onChanged }: ProjectTreeProps) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Project[]>([]);
  // Local, optimistically-reorderable copy of the list — kept in sync with `projects` whenever a
  // fresh fetch/WebSocket update arrives, and mutated immediately on drag for a responsive feel
  // while the reorder persists in the background.
  const [order, setOrder] = useState<Project[]>(projects);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    setOrder(projects);
  }, [projects]);

  useEffect(() => {
    if (!showArchived) return;
    fetch('/api/projects?includeArchived=true')
      .then((r) => r.json())
      .then((all: Project[]) => setArchived(all.filter((p) => p.archived)));
  }, [showArchived, refreshToken]);

  // Reordering only makes sense against the full, unfiltered list — disabled while a filter is
  // active so a drag can't silently reshuffle projects the user can't currently see.
  const dragEnabled = query.trim() === '';
  const filtered = order.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const reorder = (droppedId: string, targetId: string) => {
    if (droppedId === targetId) return;
    setOrder((prev) => {
      const next = [...prev];
      const fromIndex = next.findIndex((p) => p.id === droppedId);
      const toIndex = next.findIndex((p) => p.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return prev;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      api.reorderProjects(next.map((p) => p.id));
      return next;
    });
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
      <div className="p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer les projets…"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 placeholder:text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-600"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {filtered.map((p) => (
          <div
            key={p.id}
            draggable={dragEnabled}
            onDragStart={() => setDraggedId(p.id)}
            onDragOver={(e) => {
              if (!draggedId) return;
              e.preventDefault();
              if (draggedId !== p.id) setDragOverId(p.id);
            }}
            onDragLeave={() => setDragOverId((cur) => (cur === p.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedId) reorder(draggedId, p.id);
              setDraggedId(null);
              setDragOverId(null);
            }}
            onDragEnd={() => {
              setDraggedId(null);
              setDragOverId(null);
            }}
            className={`border-t-2 ${dragOverId === p.id ? 'border-indigo-400 dark:border-indigo-600' : 'border-transparent'} ${
              draggedId === p.id ? 'opacity-40' : ''
            }`}
          >
            <ProjectNode
              project={p}
              allProjects={projects}
              selected={selected}
              onSelect={onSelect}
              refreshToken={refreshToken}
              onChanged={onChanged}
              draggable={dragEnabled}
            />
          </div>
        ))}
        {filtered.length === 0 && <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-600">Aucun projet.</p>}
      </div>
      <div className="border-t border-slate-200 p-2 dark:border-slate-800">
        <label className="flex items-center gap-1.5 px-1 text-xs text-slate-500 dark:text-slate-500">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Projets archivés
        </label>
        {showArchived && (
          <div className="mt-1 space-y-0.5">
            {archived.length === 0 && <p className="px-2 py-1 text-xs text-slate-400 dark:text-slate-700">Aucun.</p>}
            {archived.map((p) => (
              <div key={p.id} className="group flex items-center justify-between px-2 py-1 text-xs text-slate-500">
                <span className="truncate">{p.name}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={async () => {
                      await api.unarchiveProject(p.id);
                      onChanged();
                    }}
                    className="rounded px-1.5 py-0.5 text-emerald-600 hover:bg-slate-200 dark:text-emerald-500 dark:hover:bg-slate-800"
                  >
                    Restaurer
                  </button>
                  <DeleteProjectButton
                    project={p}
                    onConfirm={async () => {
                      await api.deleteProject(p.id);
                      onChanged();
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
