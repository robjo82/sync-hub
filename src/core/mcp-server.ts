import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from './db.js';
import type { ProjectRegistry } from './registry.js';
import { archiveThread, type ArchiveRoots } from './archive.js';
import { updatePointerFiles } from './pointer-files.js';
import { UNASSIGNED_PROJECT_ID, type Message, type Project } from '../types.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

function resolveProject(db: Db, projectRef: string): Project | undefined {
  const byId = db.getProject(projectRef);
  if (byId) return byId;
  const needle = projectRef.trim().toLowerCase();
  return db.getProjects().find((p) => p.name.toLowerCase() === needle);
}

function formatMessage(m: Message): string {
  const engine = ENGINE_LABEL[m.sourceEngine] ?? m.sourceEngine;
  const lines = [`[${m.timestamp}] ${m.role} (${engine})`];
  if (m.content) lines.push(m.content);
  if (m.thought) lines.push(`  réflexion: ${m.thought}`);
  for (const call of m.toolCalls ?? []) lines.push(`  → appel outil ${call.name}(${JSON.stringify(call.arguments)})`);
  for (const result of m.toolResults ?? []) lines.push(`  ← résultat outil: ${result.output.slice(0, 2000)}`);
  return lines.join('\n');
}

function projectNotFoundText(db: Db, projectRef: string): string {
  const names = db
    .getProjects()
    .filter((p) => p.canonicalPath)
    .map((p) => `${p.id} (${p.name})`)
    .join(', ');
  return `Aucun projet ne correspond à "${projectRef}". Projets connus : ${names || 'aucun'}.`;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Records every call to every tool below — verbatim params and a short outcome summary — so a
 * real problem reported after the fact ("le lien n'a pas marché") can be traced to exactly what
 * was called and what sync-hub returned, instead of guessed at. One wrapper applied uniformly so
 * a newly-added tool can't accidentally be forgotten.
 */
function logged<TInput>(db: Db, tool: string, handler: (input: TInput) => Promise<ToolResult>): (input: TInput) => Promise<ToolResult> {
  return async (input: TInput) => {
    const timestamp = new Date().toISOString();
    try {
      const result = await handler(input);
      const firstText = result.content.find((c) => c.type === 'text')?.text ?? '';
      db.logMcpCall(tool, input, !!result.isError, firstText.slice(0, 300), timestamp);
      return result;
    } catch (err: any) {
      db.logMcpCall(tool, input, true, `EXCEPTION: ${err?.message ?? String(err)}`, timestamp);
      throw err;
    }
  };
}

/**
 * The live-query delivery channel: any connected tool can pull the exact verbatim cross-tool
 * history for a project at any point in the conversation — not a summary baked in once at
 * session start. Content returned here is never paraphrased; it's read straight from the
 * canonical store built by the adapters.
 */
export function createMcpServer(db: Db, registry: ProjectRegistry, archiveRoots: ArchiveRoots): McpServer {
  const server = new McpServer({ name: 'sync-hub', version: '0.1.0' });

  server.registerTool(
    'get_project_timeline',
    {
      title: 'Chronologie verbatim d\'un projet',
      description:
        "Retourne, verbatim et sans résumé, les échanges d'un projet tous outils confondus (Claude Code, Codex), " +
        "triés chronologiquement. Utilise `since` (ISO 8601) pour ne récupérer que ce qui s'est passé après un instant donné.",
      inputSchema: {
        project: z.string().describe('Id ou nom du projet (voir la liste dans le dashboard sync-hub)'),
        since: z.string().optional().describe('Horodatage ISO 8601 — ne renvoie que les messages postérieurs'),
      },
    },
    logged(db, 'get_project_timeline', async ({ project: projectRef, since }) => {
      const project = resolveProject(db, projectRef);
      if (!project) {
        return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };
      }
      const messages = db.getProjectTimeline(project.id, since);
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `Aucun message enregistré pour "${project.name}"${since ? ` depuis ${since}` : ''}.` }] };
      }
      return { content: [{ type: 'text', text: messages.map(formatMessage).join('\n\n') }] };
    }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Chronologie verbatim d\'un fil précis',
      description:
        "Retourne, verbatim, tous les messages d'un seul fil de conversation identifié par son id — utile pour reprendre " +
        "une conversation précise (ex. importée depuis ChatGPT ou Claude.ai) sans se limiter à un projet entier. " +
        "L'id se trouve dans le dashboard sync-hub (bouton « Copier l'id du fil » sur la vue d'un fil).",
      inputSchema: {
        threadId: z.string().describe('Id du fil (visible dans le dashboard sync-hub)'),
      },
    },
    logged(db, 'get_thread', async ({ threadId }) => {
      const thread = db.getThread(threadId);
      if (!thread) {
        return { content: [{ type: 'text', text: `Aucun fil avec l'id "${threadId}".` }], isError: true };
      }
      const messages = db.getMessagesForThread(threadId);
      const header = `Fil : ${thread.title} (${ENGINE_LABEL[thread.originEngine] ?? thread.originEngine})`;
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `${header}\n\nAucun message.` }] };
      }
      return { content: [{ type: 'text', text: `${header}\n\n${messages.map(formatMessage).join('\n\n')}` }] };
    }),
  );

  server.registerTool(
    'link_threads',
    {
      title: 'Lier des fils comme continuation les uns des autres',
      description:
        "Déclare explicitement que plusieurs fils (potentiellement dans des outils différents — Claude Code, Codex, un import " +
        "ChatGPT…) forment une seule continuation de conversation, plutôt que des fils indépendants. Jamais déduit " +
        "automatiquement — chaque id doit être fourni explicitement (visible via « Copier l'id du fil » dans le dashboard). " +
        "Un fil tout juste créé n'existe dans sync-hub qu'une fois son premier message ingéré (quelques secondes) — attends " +
        "ce moment avant de le lier. Relier un troisième fil à une paire déjà liée les regroupe tous les trois. Une fois liés, " +
        "utilise get_thread_link_updates depuis n'importe quel fil du groupe pour récupérer, à la demande, uniquement ce qui " +
        "s'est passé de nouveau ailleurs dans le groupe — jamais tout l'historique à chaque fois.",
      inputSchema: {
        threadIds: z.array(z.string()).min(2).describe('Au moins deux ids de fils existants à lier ensemble'),
      },
    },
    logged(db, 'link_threads', async ({ threadIds }) => {
      try {
        const linkId = db.linkThreads(threadIds);
        const link = db.getThreadLink(threadIds[0])!;
        const titles = link.threadIds.map((id) => db.getThread(id)?.title ?? id).join(' · ');
        return { content: [{ type: 'text', text: `Lien "${linkId}" : ${link.threadIds.length} fils liés — ${titles}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }),
  );

  server.registerTool(
    'unlink_thread',
    {
      title: 'Retirer un fil de son groupe de liaison',
      description:
        "Retire threadId de son groupe de fils liés (voir link_threads). Si le groupe tombe à moins de deux fils, il est " +
        "dissous entièrement. Sans effet si le fil n'était lié à rien.",
      inputSchema: {
        threadId: z.string().describe('Id du fil à délier'),
      },
    },
    logged(db, 'unlink_thread', async ({ threadId }) => {
      if (!db.getThread(threadId)) {
        return { content: [{ type: 'text', text: `Aucun fil avec l'id "${threadId}".` }], isError: true };
      }
      const hadLink = !!db.getThreadLink(threadId);
      db.unlinkThread(threadId);
      return { content: [{ type: 'text', text: hadLink ? 'Fil délié.' : "Ce fil n'était lié à rien." }] };
    }),
  );

  server.registerTool(
    'get_thread_link_updates',
    {
      title: 'Nouveautés des autres fils liés (delta uniquement)',
      description:
        "Retourne, verbatim, uniquement les messages des AUTRES fils du même groupe de liaison que threadId, apparus depuis " +
        "le dernier appel de cet outil pour ce fil précis — jamais l'historique complet. Fait avancer le curseur de ce fil à " +
        "chaque appel. Renvoie une liste vide si le fil n'est lié à aucun groupe (voir link_threads) ou si rien de nouveau.",
      inputSchema: {
        threadId: z.string().describe("Id du fil qui demande les nouveautés (visible dans le dashboard sync-hub)"),
      },
    },
    logged(db, 'get_thread_link_updates', async ({ threadId }) => {
      if (!db.getThread(threadId)) {
        return { content: [{ type: 'text', text: `Aucun fil avec l'id "${threadId}".` }], isError: true };
      }
      const link = db.getThreadLink(threadId);
      if (!link) {
        return { content: [{ type: 'text', text: `Ce fil n'est lié à aucun groupe — utilise link_threads pour en créer un.` }] };
      }
      const messages = db.getThreadLinkDelta(threadId);
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `Rien de nouveau depuis la dernière vérification dans ce groupe de ${link.threadIds.length} fils.` }] };
      }
      return { content: [{ type: 'text', text: messages.map(formatMessage).join('\n\n') }] };
    }),
  );

  server.registerTool(
    'search_transcripts',
    {
      title: 'Recherche plein texte dans les transcripts',
      description: "Recherche verbatim (sous-chaîne) dans le contenu de tous les messages ingérés, tous projets et outils confondus.",
      inputSchema: {
        query: z.string().describe('Terme à rechercher'),
        limit: z.number().int().positive().max(200).optional().describe('Nombre maximum de résultats (défaut 50)'),
      },
    },
    logged(db, 'search_transcripts', async ({ query, limit }) => {
      const results = db.searchTranscripts(query, limit ?? 50);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `Aucun résultat pour "${query}".` }] };
      }
      const text = results
        .map((m) => {
          const project = db.getProject(m.projectId);
          return `— projet: ${project?.name ?? m.projectId} —\n${formatMessage(m)}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    }),
  );

  // The tools below let a connected tool perform the same project-management actions as the
  // dashboard itself (rename, merge, assign, archive) — added because doing this by hand, one
  // project at a time, doesn't scale once there are hundreds of threads sitting unassigned.
  // Deliberately excluded: deleting a project (moves its real folder to the macOS Trash) — the
  // one action here that touches real filesystem state outside sync-hub's own store, left as a
  // dashboard-only action with its own explicit confirmation UI.

  server.registerTool(
    'list_projects',
    {
      title: 'Lister tous les projets connus',
      description:
        "Retourne tous les projets sync-hub (id, nom, chemin réel si connu, catégorie, nombre de fils, archivé ou non) — y " +
        'compris le projet spécial "unassigned" ("Non affecté") qui regroupe les fils qu\'aucune règle n\'a pu rattacher ' +
        'automatiquement à un vrai projet. Point de départ pour toute réorganisation : repère les projets concernés ici avant ' +
        'de lister leurs fils avec list_threads ou de les catégoriser avec set_project_category.',
      inputSchema: {},
    },
    logged(db, 'list_projects', async () => {
      const projects = db.getProjects();
      const lines = projects.map((p) => {
        const count = db.countThreadsForProject(p.id);
        const path = p.canonicalPath ? ` — ${p.canonicalPath}` : '';
        const category = p.category ? ` [${p.category}]` : '';
        const archived = p.archived ? ' [archivé]' : '';
        return `${p.id} — ${p.name}${path} (${count} fil${count === 1 ? '' : 's'})${category}${archived}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
  );

  server.registerTool(
    'list_threads',
    {
      title: "Lister les fils d'un projet (vue compacte, pas le contenu complet)",
      description:
        "Liste les fils d'un projet — id, titre, outil d'origine, dates, nombre de messages, et un court extrait verbatim " +
        "(jamais résumé) du premier message utilisateur pour se repérer sans tout charger. Utilise project=\"unassigned\" " +
        "pour voir les fils en attente de triage. Pour le contenu complet d'un fil précis, utilise get_thread.",
      inputSchema: {
        project: z.string().describe('Id ou nom du projet — "unassigned" pour les fils non affectés'),
      },
    },
    logged(db, 'list_threads', async ({ project: projectRef }) => {
      const project = resolveProject(db, projectRef);
      if (!project) {
        return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };
      }
      const threads = db.getThreadsForProject(project.id);
      if (threads.length === 0) {
        return { content: [{ type: 'text', text: `Aucun fil dans "${project.name}".` }] };
      }
      const lines = threads.map((t) => {
        const firstUser = db.getMessagesForThread(t.id).find((m) => m.role === 'user');
        const excerpt = firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        return (
          `${t.id} — ${t.title} (${ENGINE_LABEL[t.originEngine] ?? t.originEngine}, ${t.messageCount} messages, maj ${t.updatedAt})` +
          (excerpt ? `\n  extrait: ${excerpt}` : '')
        );
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
  );

  server.registerTool(
    'rename_project',
    {
      title: 'Renommer un projet',
      description: 'Change le nom affiché d\'un projet — ne touche ni son chemin réel ni ses fils.',
      inputSchema: {
        project: z.string().describe('Id ou nom actuel du projet'),
        name: z.string().min(1).describe('Nouveau nom'),
      },
    },
    logged(db, 'rename_project', async ({ project: projectRef, name }) => {
      const project = resolveProject(db, projectRef);
      if (!project) {
        return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };
      }
      db.renameProject(project.id, name.trim());
      updatePointerFiles(db, db.getProject(project.id)!);
      return { content: [{ type: 'text', text: `"${project.name}" renommé en "${name.trim()}".` }] };
    }),
  );

  server.registerTool(
    'set_project_category',
    {
      title: 'Catégoriser un projet',
      description:
        "Assigne un projet à une catégorie libre pour le regroupement dans le dashboard — au minimum \"ekonum\" (outillage/travaux " +
        'internes Ekonum), "client" (missions pour un client identifié) et "perso" sont utilisées, mais toute étiquette est ' +
        'acceptée. Jamais deviné : n\'assigne que ce qui est explicitement demandé. category=null retire le projet de toute catégorie.',
      inputSchema: {
        project: z.string().describe('Id ou nom du projet'),
        category: z.string().nullable().describe('Étiquette de catégorie (ex: "ekonum", "client", "perso"), ou null pour retirer'),
      },
    },
    logged(db, 'set_project_category', async ({ project: projectRef, category }) => {
      const project = resolveProject(db, projectRef);
      if (!project) {
        return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };
      }
      const trimmed = category?.trim() || null;
      db.setProjectCategory(project.id, trimmed);
      return {
        content: [{ type: 'text', text: trimmed ? `"${project.name}" classé dans "${trimmed}".` : `"${project.name}" retiré de sa catégorie.` }],
      };
    }),
  );

  server.registerTool(
    'merge_projects',
    {
      title: 'Fusionner un projet dans un autre',
      description:
        "Déplace tous les fils, mémoires et artefacts de source vers target (qui conserve son nom), et fait disparaître " +
        'source de la liste des projets. Fusion pure côté enregistrements sync-hub — aucun fichier réel touché. Irréversible ' +
        "en un clic (pas de \"dé-fusion\"), donc à utiliser seulement quand source et target sont vraiment le même projet réel.",
      inputSchema: {
        source: z.string().describe('Id ou nom du projet à absorber (disparaît après fusion)'),
        target: z.string().describe('Id ou nom du projet qui reçoit tout et garde son nom'),
      },
    },
    logged(db, 'merge_projects', async ({ source, target }) => {
      const sourceProject = resolveProject(db, source);
      const targetProject = resolveProject(db, target);
      if (!sourceProject) return { content: [{ type: 'text', text: projectNotFoundText(db, source) }], isError: true };
      if (!targetProject) return { content: [{ type: 'text', text: projectNotFoundText(db, target) }], isError: true };
      if (sourceProject.id === UNASSIGNED_PROJECT_ID || targetProject.id === UNASSIGNED_PROJECT_ID) {
        return { content: [{ type: 'text', text: 'Le projet "unassigned" ne peut ni être fusionné ni recevoir de fusion.' }], isError: true };
      }
      try {
        db.mergeProjects(sourceProject.id, targetProject.id);
      } catch (err: any) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      updatePointerFiles(db, db.getProject(targetProject.id)!);
      return { content: [{ type: 'text', text: `"${sourceProject.name}" fusionné dans "${targetProject.name}".` }] };
    }),
  );

  server.registerTool(
    'assign_thread_to_project',
    {
      title: 'Rattacher un fil à un projet',
      description:
        "Déplace un fil précis vers un autre projet — l'action de triage principale pour les fils \"unassigned\". Si le fil a " +
        "une référence native connue (slug Claude Code, cwd Codex), sync-hub apprend aussi cette référence pour ce projet, " +
        'pour que les futurs fils de la même source se rattachent automatiquement sans repasser par un triage manuel.',
      inputSchema: {
        threadId: z.string().describe('Id du fil à déplacer'),
        project: z.string().describe('Id ou nom du projet cible'),
      },
    },
    logged(db, 'assign_thread_to_project', async ({ threadId, project: projectRef }) => {
      const thread = db.getThread(threadId);
      if (!thread) return { content: [{ type: 'text', text: `Aucun fil avec l'id "${threadId}".` }], isError: true };
      const target = resolveProject(db, projectRef);
      if (!target) return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };

      if (thread.sourceRef) {
        const kind = thread.originEngine === 'claude-code' ? 'claudeSlugs' : thread.originEngine === 'codex' ? 'codexCwds' : null;
        if (kind) registry.assign(target.id, kind, thread.sourceRef);
      }
      db.reassignThread(thread.id, target.id);
      updatePointerFiles(db, target);
      return { content: [{ type: 'text', text: `"${thread.title}" rattaché à "${target.name}".` }] };
    }),
  );

  server.registerTool(
    'archive_thread',
    {
      title: 'Archiver un fil',
      description:
        "Déplace le fichier source réel du fil (jamais supprimé — archive native de l'outil pour Codex, dossier " +
        "sync-hub sinon) et le masque de la vue par défaut du dashboard. Un fil sans fichier source réel (import en masse) " +
        "est archivé côté enregistrements sync-hub uniquement.",
      inputSchema: {
        threadId: z.string().describe('Id du fil à archiver'),
      },
    },
    logged(db, 'archive_thread', async ({ threadId }) => {
      const thread = db.getThread(threadId);
      if (!thread) return { content: [{ type: 'text', text: `Aucun fil avec l'id "${threadId}".` }], isError: true };
      const result = archiveThread(db, thread, archiveRoots);
      return { content: [{ type: 'text', text: `"${thread.title}" — ${result.note}` }] };
    }),
  );

  server.registerTool(
    'archive_project',
    {
      title: 'Archiver un projet (et tous ses fils actifs)',
      description:
        'Masque le projet du dashboard et archive (voir archive_thread) chacun de ses fils encore actifs — au mieux : un ' +
        'déplacement de fichier en échec pour un fil ne bloque pas les autres.',
      inputSchema: {
        project: z.string().describe('Id ou nom du projet à archiver'),
      },
    },
    logged(db, 'archive_project', async ({ project: projectRef }) => {
      const project = resolveProject(db, projectRef);
      if (!project) return { content: [{ type: 'text', text: projectNotFoundText(db, projectRef) }], isError: true };
      if (project.id === UNASSIGNED_PROJECT_ID) {
        return { content: [{ type: 'text', text: 'Le projet "unassigned" ne peut pas être archivé.' }], isError: true };
      }
      const results = db
        .getThreadsForProject(project.id)
        .filter((t) => t.status === 'active')
        .map((t) => archiveThread(db, t, archiveRoots));
      db.setProjectArchived(project.id, true);
      return { content: [{ type: 'text', text: `"${project.name}" archivé (${results.length} fil(s) traité(s)).` }] };
    }),
  );

  return server;
}
