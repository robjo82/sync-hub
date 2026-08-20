import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Archive, Check, ChevronDown, ChevronRight, FileText, GitMerge, GripVertical, Pencil, Settings, StickyNote, Tag, Trash2, X } from 'lucide-react';
import type { Artifact, Category, Memory, Project, Thread } from '../../types.js';
import { api } from '../lib/api.js';

const ENGINE_DOT: Record<string, string> = {
  'claude-code': 'bg-engine-claude',
  codex: 'bg-engine-codex',
  antigravity: 'bg-engine-antigravity',
};

export type SelectedItem = { kind: 'thread'; id: string } | { kind: 'memory'; item: Memory } | { kind: 'artifact'; item: Artifact } | null;

interface ProjectTreeProps {
  projects: Project[];
  selected: SelectedItem;
  onSelect: (item: SelectedItem) => void;
  refreshToken: number;
  onChanged: () => void;
  /** Set (once) to expand + scroll to a thread opened from somewhere other than clicking it in
   * the tree (e.g. search) — consumed via onFocusHandled so it doesn't re-trigger on every render. */
  focusThreadId?: string | null;
  onFocusHandled?: () => void;
}

interface ProjectChildren {
  threads: Thread[];
  memories: Memory[];
  artifacts: Artifact[];
}

// Native window.prompt/confirm/alert turned out to be unreliable in practice — silently blocked
// in some browser/embedding contexts, with no visible error to the user (verified: it throws
// "prompt() is not supported." in at least one real environment sync-hub runs in). Every
// destructive/edit action below is an inline panel instead, matching MergeProjectPanel's existing
// pattern — no dependency on a native dialog actually being allowed to open.

function IconButton({ title, onClick, className, children }: { title: string; onClick: () => void; className: string; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`ml-1 hidden shrink-0 items-center rounded p-1 text-muted-foreground group-hover:flex ${className}`}
    >
      {children}
    </button>
  );
}

const panelInputClass =
  'w-0 min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-1 text-xs text-foreground placeholder:text-muted-foreground';
const panelConfirmClass = 'shrink-0 rounded p-1 text-accent hover:bg-accent-muted disabled:opacity-40';
const panelCancelClass = 'shrink-0 rounded p-1 text-muted-foreground hover:bg-muted';

function RenamePanel({ project, onConfirm, onCancel }: { project: Project; onConfirm: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(project.name);
  return (
    <div className="mb-1 ml-5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim() && name.trim() !== project.name) onConfirm(name.trim());
          else if (e.key === 'Escape') onCancel();
        }}
        className={panelInputClass}
      />
      <button title="Confirmer" disabled={!name.trim() || name.trim() === project.name} onClick={() => onConfirm(name.trim())} className={panelConfirmClass}>
        <Check size={14} />
      </button>
      <button title="Annuler" onClick={onCancel} className={panelCancelClass}>
        <X size={14} />
      </button>
    </div>
  );
}

function CategoryPanel({
  project,
  categories,
  onConfirm,
  onCancel,
}: {
  project: Project;
  categories: Category[];
  onConfirm: (category: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(project.category ?? '');
  return (
    <div className="mb-1 ml-5 space-y-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Catégorie…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value.trim() || null);
            else if (e.key === 'Escape') onCancel();
          }}
          className={panelInputClass}
        />
        <button title="Confirmer" onClick={() => onConfirm(value.trim() || null)} className={panelConfirmClass}>
          <Check size={14} />
        </button>
        <button title="Annuler" onClick={onCancel} className={panelCancelClass}>
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {categories.map((c) => (
          <button
            key={c.name}
            onClick={() => setValue(c.name)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              value === c.name ? 'border-accent bg-accent-muted text-accent-muted-foreground' : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {c.name}
          </button>
        ))}
        {project.category && (
          <button onClick={() => onConfirm(null)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
            retirer
          </button>
        )}
      </div>
    </div>
  );
}

/** Inline "manage categories" panel: rename/delete existing ones, add a new one ahead of assigning
 * it to any project. Same native-dialog-free pattern as everything else here. */
function CategoryManagerPanel({ categories, onChanged, onClose }: { categories: Category[]; onChanged: () => void; onClose: () => void }) {
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addCategory = async () => {
    const name = newName.trim();
    if (!name) return;
    await api.createCategory(name);
    setNewName('');
    onChanged();
  };

  return (
    <div className="space-y-1 border-b border-border bg-card p-2" onClick={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Catégories</span>
        <button onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-muted">
          <X size={14} />
        </button>
      </div>
      {categories.length === 0 && <p className="px-1 text-xs text-muted-foreground">Aucune catégorie pour le moment.</p>}
      {categories.map((c) => (
        <div key={c.name} className="flex items-center gap-1 rounded px-1 py-0.5">
          {renaming === c.name ? (
            <>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && renameValue.trim() && renameValue.trim() !== c.name) {
                    try {
                      await api.renameCategory(c.name, renameValue.trim());
                      setRenaming(null);
                      setError(null);
                      onChanged();
                    } catch {
                      setError(`"${renameValue.trim()}" existe déjà.`);
                    }
                  } else if (e.key === 'Escape') setRenaming(null);
                }}
                className={panelInputClass}
              />
              <button
                onClick={async () => {
                  if (!renameValue.trim() || renameValue.trim() === c.name) return setRenaming(null);
                  try {
                    await api.renameCategory(c.name, renameValue.trim());
                    setRenaming(null);
                    setError(null);
                    onChanged();
                  } catch {
                    setError(`"${renameValue.trim()}" existe déjà.`);
                  }
                }}
                className={panelConfirmClass}
              >
                <Check size={14} />
              </button>
              <button onClick={() => setRenaming(null)} className={panelCancelClass}>
                <X size={14} />
              </button>
            </>
          ) : confirmingDelete === c.name ? (
            <>
              <span className="flex-1 truncate text-xs text-muted-foreground">
                Supprimer « {c.name} » ? {c.projectCount > 0 && `${c.projectCount} projet${c.projectCount === 1 ? '' : 's'} repasseront sans catégorie.`}
              </span>
              <button
                onClick={async () => {
                  await api.deleteCategory(c.name);
                  setConfirmingDelete(null);
                  onChanged();
                }}
                className="shrink-0 rounded p-1 text-destructive hover:bg-destructive-muted"
              >
                <Check size={14} />
              </button>
              <button onClick={() => setConfirmingDelete(null)} className={panelCancelClass}>
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 truncate text-xs text-foreground">{c.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{c.projectCount}</span>
              <button
                title="Renommer"
                onClick={() => {
                  setRenaming(c.name);
                  setRenameValue(c.name);
                  setError(null);
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil size={12} />
              </button>
              <button
                title="Supprimer"
                onClick={() => setConfirmingDelete(c.name)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive-muted hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      ))}
      {error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
      <div className="mt-1 flex items-center gap-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCategory()}
          placeholder="Nouvelle catégorie…"
          className={panelInputClass}
        />
        <button onClick={addCategory} disabled={!newName.trim()} className={panelConfirmClass}>
          <Check size={14} />
        </button>
      </div>
    </div>
  );
}

function ArchivePanel({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mb-1 ml-5 flex items-center gap-2 text-xs text-muted-foreground" onClick={(e) => e.stopPropagation()}>
      <span className="flex-1 truncate">Archiver « {title} » ? Le fichier source est déplacé, jamais supprimé.</span>
      <button title="Confirmer" onClick={onConfirm} className="shrink-0 rounded p-1 text-warning hover:bg-warning-muted">
        <Check size={14} />
      </button>
      <button title="Annuler" onClick={onCancel} className={panelCancelClass}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Full-width picker for folding a project into another one — a pure DB reassignment
 * (threads/memories/artifacts move, aliases merge), never touches real files. Useful when the same
 * real project was independently discovered under two identities (e.g. a live Codex project and an
 * unrelated-looking ChatGPT Project that turns out to be the same client). Rendered as its own row
 * below the project title rather than squeezed inline — the sidebar is too narrow for a select full
 * of project names plus confirm/cancel buttons to fit next to the title and other icons. The
 * explanation of what a merge does is shown inline (below) rather than gated behind a second,
 * separate confirm dialog — picking a target and clicking ✓ already is the confirmation step. */
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
  const target = otherProjects.find((p) => p.id === targetId);

  return (
    <div className="mb-1 ml-5 space-y-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <select autoFocus value={targetId} onChange={(e) => setTargetId(e.target.value)} className={panelInputClass}>
          <option value="">Fusionner dans…</option>
          {otherProjects
            .filter((p) => p.id !== project.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <button title="Confirmer la fusion" disabled={!targetId} onClick={() => onConfirm(targetId)} className={panelConfirmClass}>
          <Check size={14} />
        </button>
        <button title="Annuler" onClick={onCancel} className={panelCancelClass}>
          <X size={14} />
        </button>
      </div>
      {target && (
        <p className="text-[11px] text-muted-foreground">
          Fils, mémoires et artefacts déplacés vers « {target.name} », qui conserve son nom. « {project.name} » disparaît de la liste. Aucun
          fichier réel touché.
        </p>
      )}
    </div>
  );
}

function DeletePanel({ project, onConfirm, onCancel }: { project: Project; onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const matches = typed === project.name;

  return (
    <div className="mb-1 ml-5 space-y-1" onClick={(e) => e.stopPropagation()}>
      <p className="text-[11px] text-muted-foreground">
        Déplace le dossier réel ({project.canonicalPath || 'aucun'}) vers la Corbeille macOS — récupérable tant qu'elle n'est pas vidée. Tape le
        nom du projet pour confirmer :
      </p>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setMismatch(false);
          }}
          placeholder={project.name}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (matches) onConfirm();
              else setMismatch(true);
            } else if (e.key === 'Escape') onCancel();
          }}
          className={panelInputClass}
        />
        <button
          title="Confirmer la suppression"
          onClick={() => (matches ? onConfirm() : setMismatch(true))}
          disabled={!typed}
          className="shrink-0 rounded p-1 text-destructive hover:bg-destructive-muted disabled:opacity-40"
        >
          <Check size={14} />
        </button>
        <button title="Annuler" onClick={onCancel} className={panelCancelClass}>
          <X size={14} />
        </button>
      </div>
      {mismatch && <p className="text-[11px] text-destructive">Nom incorrect — rien n'a été supprimé.</p>}
    </div>
  );
}

/** Self-contained archive icon for a single thread row: swaps itself for an inline confirm/cancel
 * pair on click, rather than a native confirm() — same reasoning as the panels above. */
function ThreadArchiveButton({ title, onConfirm }: { title: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="ml-1 flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()} title={`Archiver « ${title} » ?`}>
        <button onClick={onConfirm} className="rounded p-1 text-warning hover:bg-warning-muted">
          <Check size={13} />
        </button>
        <button onClick={() => setConfirming(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X size={13} />
        </button>
      </span>
    );
  }
  return (
    <IconButton title="Archiver" onClick={() => setConfirming(true)} className="hover:bg-warning-muted hover:text-warning">
      <Archive size={13} />
    </IconButton>
  );
}

/** Self-contained "type the name to confirm" delete for a single row (used in the archived-projects
 * list, outside ProjectNode's single-active-panel state) — a compact variant of DeletePanel that
 * fits inline in a flex row instead of taking a full-width block below the row. */
function RowDeleteButton({ project, onConfirm }: { project: Project; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed === project.name;

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-0.5" title={`Tape « ${project.name} » pour confirmer la suppression`}>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={project.name}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches) onConfirm();
            else if (e.key === 'Escape') setConfirming(false);
          }}
          className="w-20 rounded border border-border bg-card px-1.5 py-1 text-xs text-foreground"
        />
        <button onClick={onConfirm} disabled={!matches} className="rounded p-1 text-destructive hover:bg-destructive-muted disabled:opacity-40">
          <Check size={13} />
        </button>
        <button
          onClick={() => {
            setConfirming(false);
            setTyped('');
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X size={13} />
        </button>
      </span>
    );
  }
  return (
    <button
      title="Supprimer le projet (déplace le dossier vers la Corbeille)"
      onClick={() => setConfirming(true)}
      className="rounded p-1 text-muted-foreground hover:bg-destructive-muted hover:text-destructive"
    >
      <Trash2 size={13} />
    </button>
  );
}

function ProjectNode({
  project,
  allProjects,
  categories,
  selected,
  onSelect,
  refreshToken,
  onChanged,
  draggable,
  focusProjectId,
  focusThreadId,
  onFocusHandled,
}: {
  project: Project;
  allProjects: Project[];
  categories: Category[];
  draggable: boolean;
  focusProjectId?: string | null;
  focusThreadId?: string | null;
  onFocusHandled?: () => void;
} & Omit<ProjectTreeProps, 'projects' | 'focusThreadId' | 'onFocusHandled'>) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ProjectChildren | null>(null);
  const [activePanel, setActivePanel] = useState<'rename' | 'category' | 'merge' | 'archive' | 'delete' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const threadRefs = useRef(new Map<string, HTMLDivElement>());
  const isFocusTarget = !!focusProjectId && project.id === focusProjectId;

  useEffect(() => {
    if (!expanded) return;
    Promise.all([api.threads(project.id), api.memories(project.id), api.artifacts(project.id)]).then(([threads, memories, artifacts]) =>
      setChildren({ threads, memories, artifacts }),
    );
  }, [expanded, project.id, refreshToken]);

  // Opened from search (or anywhere else outside the tree): expand this project and scroll it
  // into view, then — once its threads are loaded — scroll to the specific thread row.
  useEffect(() => {
    if (!isFocusTarget) return;
    setExpanded(true);
    rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [isFocusTarget]);

  useEffect(() => {
    if (!isFocusTarget || !focusThreadId || !children) return;
    threadRefs.current.get(focusThreadId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    onFocusHandled?.();
  }, [isFocusTarget, focusThreadId, children]);

  const closePanel = () => setActivePanel(null);

  return (
    <div ref={rootRef}>
      <div className={`group flex items-center rounded-md hover:bg-muted ${isFocusTarget ? 'bg-accent-muted' : ''}`}>
        {draggable && (
          <span title="Glisser pour réorganiser" className="hidden shrink-0 cursor-grab px-1 text-muted-foreground group-hover:block">
            <GripVertical size={14} />
          </span>
        )}
        <button onClick={() => setExpanded((e) => !e)} className="flex flex-1 items-center gap-1.5 overflow-hidden px-2 py-1.5 text-left text-sm text-foreground">
          <span className="text-muted-foreground">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="truncate">{project.name}</span>
        </button>
        <IconButton title="Renommer" onClick={() => setActivePanel('rename')} className="hover:bg-muted hover:text-foreground">
          <Pencil size={13} />
        </IconButton>
        <IconButton title="Catégoriser" onClick={() => setActivePanel('category')} className="hover:bg-accent-muted hover:text-accent">
          <Tag size={13} />
        </IconButton>
        <IconButton title="Fusionner dans un autre projet" onClick={() => setActivePanel('merge')} className="hover:bg-accent-muted hover:text-accent">
          <GitMerge size={13} />
        </IconButton>
        <IconButton title="Archiver" onClick={() => setActivePanel('archive')} className="hover:bg-warning-muted hover:text-warning">
          <Archive size={13} />
        </IconButton>
        <IconButton
          title="Supprimer le projet (déplace le dossier vers la Corbeille)"
          onClick={() => setActivePanel('delete')}
          className="hover:bg-destructive-muted hover:text-destructive"
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
      {activePanel === 'rename' && (
        <RenamePanel
          project={project}
          onConfirm={async (name) => {
            closePanel();
            await api.renameProject(project.id, name);
            onChanged();
          }}
          onCancel={closePanel}
        />
      )}
      {activePanel === 'category' && (
        <CategoryPanel
          project={project}
          categories={categories}
          onConfirm={async (category) => {
            closePanel();
            await api.setProjectCategory(project.id, category);
            onChanged();
          }}
          onCancel={closePanel}
        />
      )}
      {activePanel === 'merge' && (
        <MergeProjectPanel
          project={project}
          otherProjects={allProjects}
          onConfirm={async (targetId) => {
            closePanel();
            await api.mergeProject(project.id, targetId);
            onChanged();
          }}
          onCancel={closePanel}
        />
      )}
      {activePanel === 'archive' && (
        <ArchivePanel
          title={project.name}
          onConfirm={async () => {
            closePanel();
            await api.archiveProject(project.id);
            onChanged();
          }}
          onCancel={closePanel}
        />
      )}
      {activePanel === 'delete' && (
        <DeletePanel
          project={project}
          onConfirm={async () => {
            closePanel();
            await api.deleteProject(project.id);
            onChanged();
          }}
          onCancel={closePanel}
        />
      )}
      {expanded && children && (
        <div className="ml-5 border-l border-border pl-2">
          {children.threads.length === 0 && children.memories.length === 0 && children.artifacts.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">Rien pour l'instant.</p>
          )}
          {children.threads.map((t) => (
            <div
              key={t.id}
              ref={(el) => {
                if (el) threadRefs.current.set(t.id, el);
                else threadRefs.current.delete(t.id);
              }}
              className="group flex items-center rounded-md"
            >
              <button
                onClick={() => onSelect({ kind: 'thread', id: t.id })}
                className={`flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs ${
                  selected?.kind === 'thread' && selected.id === t.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ENGINE_DOT[t.originEngine] ?? 'bg-muted-foreground'}`} />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{t.messageCount}</span>
              </button>
              <ThreadArchiveButton
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
              className="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <StickyNote size={12} className="shrink-0" />
              <span className="truncate">{m.filePath.split('/').pop()}</span>
            </button>
          ))}
          {children.artifacts.map((a) => (
            <button
              key={a.id}
              onClick={() => onSelect({ kind: 'artifact', item: a })}
              className="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <FileText size={12} className="shrink-0" />
              <span className="truncate">{a.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The minimum set Robin asked for sorts first, in this order; any other category the user typed
// follows alphabetically, and uncategorized projects always sort last.
const CATEGORY_ORDER = ['ekonum', 'client', 'perso'];

function categoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

interface CategoryGroup {
  key: string;
  label: string;
  projects: Project[];
}

function groupByCategory(list: Project[]): CategoryGroup[] {
  const map = new Map<string, Project[]>();
  for (const p of list) {
    const key = p.category ?? '';
    (map.get(key) ?? map.set(key, []).get(key)!).push(p);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? CATEGORY_ORDER.length : ia) - (ib === -1 ? CATEGORY_ORDER.length : ib);
    return a.localeCompare(b);
  });
  return keys.map((key) => ({ key: key || '__uncategorized__', label: key ? categoryLabel(key) : 'Sans catégorie', projects: map.get(key)! }));
}

function ProjectRow({
  project,
  allProjects,
  categories,
  selected,
  onSelect,
  refreshToken,
  onChanged,
  draggable,
  isDragOver,
  isDragging,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  focusProjectId,
  focusThreadId,
  onFocusHandled,
}: {
  project: Project;
  allProjects: Project[];
  categories: Category[];
  draggable: boolean;
  isDragOver: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  focusProjectId?: string | null;
} & Omit<ProjectTreeProps, 'projects'>) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`border-t-2 ${isDragOver ? 'border-accent' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''}`}
    >
      <ProjectNode
        project={project}
        focusProjectId={focusProjectId}
        focusThreadId={focusThreadId}
        onFocusHandled={onFocusHandled}
        allProjects={allProjects}
        categories={categories}
        selected={selected}
        onSelect={onSelect}
        refreshToken={refreshToken}
        onChanged={onChanged}
        draggable={draggable}
      />
    </div>
  );
}

export function ProjectTree({ projects, selected, onSelect, refreshToken, onChanged, focusThreadId, onFocusHandled }: ProjectTreeProps) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Project[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Category[]>([]);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [focusProjectId, setFocusProjectId] = useState<string | null>(null);
  // Local, optimistically-reorderable copy of the list — kept in sync with `projects` whenever a
  // fresh fetch/WebSocket update arrives, and mutated immediately on drag for a responsive feel
  // while the reorder persists in the background.
  const [order, setOrder] = useState<Project[]>(projects);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const loadCategories = () => api.categories().then(setCategories);
  useEffect(() => {
    loadCategories();
  }, [refreshToken]);

  useEffect(() => {
    setOrder(projects);
  }, [projects]);

  // A thread was opened from outside the tree (search) — look up its project, un-collapse that
  // project's category group so it's actually visible, then let ProjectNode take over (expand
  // itself, scroll into view, scroll to the specific thread once loaded).
  useEffect(() => {
    if (!focusThreadId) return;
    api
      .thread(focusThreadId)
      .then((t) => {
        setFocusProjectId(t.projectId);
        const proj = projects.find((p) => p.id === t.projectId);
        const groupKey = proj?.category || '__uncategorized__';
        setCollapsedGroups((prev) => {
          if (!prev.has(groupKey)) return prev;
          const next = new Set(prev);
          next.delete(groupKey);
          return next;
        });
      })
      .catch(() => onFocusHandled?.());
  }, [focusThreadId]);

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
  const groups = groupByCategory(filtered);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Dropping a project onto a row (or a group header) both repositions it and — if the drop
  // target belongs to a different category — reclassifies it into that category. targetId is
  // omitted when dropping directly on a group header (no specific row to reposition next to).
  const moveProject = (droppedId: string, targetCategory: string | null, targetId?: string) => {
    setOrder((prev) => {
      const fromIndex = prev.findIndex((p) => p.id === droppedId);
      if (fromIndex === -1) return prev;
      const dragged = prev[fromIndex];
      const categoryChanged = (dragged.category ?? null) !== targetCategory;
      const next = [...prev];

      if (targetId && targetId !== droppedId) {
        next.splice(fromIndex, 1);
        const toIndex = next.findIndex((p) => p.id === targetId);
        if (toIndex === -1) return prev;
        next.splice(toIndex, 0, categoryChanged ? { ...dragged, category: targetCategory } : dragged);
        api.reorderProjects(next.map((p) => p.id));
      } else if (categoryChanged) {
        next[fromIndex] = { ...dragged, category: targetCategory };
      } else {
        return prev;
      }

      if (categoryChanged) api.setProjectCategory(droppedId, targetCategory).then(loadCategories);
      return next;
    });
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/40">
      <div className="flex items-center gap-1 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer les projets…"
          className="w-0 min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
        />
        <button
          title="Gérer les catégories"
          onClick={() => setShowCategoryManager((v) => !v)}
          className={`shrink-0 rounded-md border p-1.5 ${showCategoryManager ? 'border-accent bg-accent-muted text-accent' : 'border-border text-muted-foreground hover:bg-muted'}`}
        >
          <Settings size={15} />
        </button>
      </div>
      {showCategoryManager && (
        <CategoryManagerPanel
          categories={categories}
          onChanged={() => {
            loadCategories();
            onChanged();
          }}
          onClose={() => setShowCategoryManager(false)}
        />
      )}
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {groups.map((group) => {
          const isSingleGroup = groups.length === 1 && group.key === '__uncategorized__';
          const collapsed = collapsedGroups.has(group.key);
          const groupCategory = group.key === '__uncategorized__' ? null : group.key;
          return (
            <div key={group.key} className="mb-1">
              {!isSingleGroup && (
                <button
                  onClick={() => toggleGroup(group.key)}
                  onDragOver={(e) => {
                    if (!draggedId) return;
                    e.preventDefault();
                    setDragOverGroup(group.key);
                  }}
                  onDragLeave={() => setDragOverGroup((cur) => (cur === group.key ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedId) moveProject(draggedId, groupCategory);
                    setDraggedId(null);
                    setDragOverGroup(null);
                  }}
                  className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase ${
                    dragOverGroup === group.key ? 'bg-accent-muted text-accent' : ''
                  }`}
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  {group.label}
                  <span className="text-muted-foreground/60 normal-case">({group.projects.length})</span>
                </button>
              )}
              {!collapsed &&
                group.projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    allProjects={projects}
                    categories={categories}
                    selected={selected}
                    onSelect={onSelect}
                    refreshToken={refreshToken}
                    onChanged={onChanged}
                    draggable={dragEnabled}
                    focusProjectId={focusProjectId}
                    focusThreadId={focusThreadId}
                    onFocusHandled={onFocusHandled}
                    isDragOver={dragOverId === p.id}
                    isDragging={draggedId === p.id}
                    onDragStart={() => setDraggedId(p.id)}
                    onDragOver={(e) => {
                      if (!draggedId) return;
                      e.preventDefault();
                      if (draggedId !== p.id) setDragOverId(p.id);
                    }}
                    onDragLeave={() => setDragOverId((cur) => (cur === p.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedId) moveProject(draggedId, groupCategory, p.id);
                      setDraggedId(null);
                      setDragOverId(null);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragOverId(null);
                      setDragOverGroup(null);
                    }}
                  />
                ))}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Aucun projet.</p>}
      </div>
      <div className="border-t border-border p-2">
        <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Projets archivés
        </label>
        {showArchived && (
          <div className="mt-1 space-y-0.5">
            {archived.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Aucun.</p>}
            {archived.map((p) => (
              <div key={p.id} className="group flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
                <span className="truncate">{p.name}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={async () => {
                      await api.unarchiveProject(p.id);
                      onChanged();
                    }}
                    className="rounded px-1.5 py-0.5 text-success hover:bg-success-muted"
                  >
                    Restaurer
                  </button>
                  <RowDeleteButton
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
