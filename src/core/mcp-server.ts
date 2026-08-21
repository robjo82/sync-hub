import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from './db.js';
import type { ProjectRegistry } from './registry.js';
import { archiveThread, deleteThread, type ArchiveRoots } from './archive.js';
import { updatePointerFiles } from './pointer-files.js';
import { tryIngestMissingThread, type IngestSingleRoots } from './ingest-single.js';
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
export function createMcpServer(
  db: Db,
  registry: ProjectRegistry,
  archiveRoots: ArchiveRoots,
  ingestSingleRoots: IngestSingleRoots = {},
): McpServer {
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
        "Si un id fourni (ex. le fil courant, tout juste créé) n'est pas encore connu, une ingestion ciblée de ce fil précis " +
        "est tentée automatiquement avant d'échouer — inutile d'attendre exprès avant d'appeler cet outil. Relier un troisième " +
        "fil à une paire déjà liée les regroupe tous les trois. Une fois liés, appelle get_thread_link_updates depuis " +
        "n'importe quel fil du groupe — systématiquement en début de tour tant que le fil est actif — pour récupérer, à la " +
        "demande, uniquement ce qui s'est passé de nouveau ailleurs dans le groupe, jamais tout l'historique à chaque fois.",
      inputSchema: {
        threadIds: z.array(z.string()).min(2).describe('Au moins deux ids de fils existants à lier ensemble'),
      },
    },
    logged(db, 'link_threads', async ({ threadIds }) => {
      for (const id of threadIds) {
        if (!db.getThread(id)) tryIngestMissingThread(db, registry, id, ingestSingleRoots);
      }
      try {
        const linkId = db.linkThreads(threadIds);
        const link = db.getThreadLink(threadIds[0])!;
        const titles = link.threadIds.map((id) => db.getThread(id)?.title ?? id).join(' · ');
        return {
          content: [
            {
              type: 'text',
              text:
                `Lien "${linkId}" : ${link.threadIds.length} fils liés — ${titles}\n` +
                'Pense à appeler get_thread_link_updates(threadId=<ton id>) en début de tour à partir de maintenant pour ' +
                'connaître les nouveautés des autres fils de ce groupe, sans tout relire.',
            },
          ],
        };
      } catch (err: any) {
        const hint =
          /unknown thread id/.test(err.message)
            ? " Une ingestion ciblée de ce fil vient d'être tentée sans succès — s'il vient tout juste d'être créé, son " +
              'premier message n\'est peut-être pas encore écrit sur disque : réessaie dans quelques secondes.'
            : '';
        return { content: [{ type: 'text', text: err.message + hint }], isError: true };
      }
    }),
  );

  // unlink is exposed as manage_thread's `unlink` action (see below) — kept there rather than as
  // its own tool since it's the same "rarely-used thread admin action" bucket as assign/archive/delete.

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

  // manage_project / manage_thread bundle every rarely-used admin action (rename, categorize,
  // merge, archive, assign, delete, unlink) behind one tool per entity, selected by `action` —
  // real mcp_call_log data showed these 12 actions, split across 12 separate tool definitions,
  // had NEVER been called even once in production, while their combined JSON schemas made up
  // roughly a third of the whole server's tool-list context cost paid by every connected session.
  // Consolidating them costs nothing in practice (nothing was relying on the separate names) and
  // meaningfully shrinks that fixed per-session overhead. The 7 tools that ARE actually used
  // (get_thread, list_threads, search_transcripts, link_threads…) stay separate and unbundled —
  // a clear standalone tool name is worth keeping for the ones a caller actually reaches for.
  // Deliberately excluded from manage_project: deleting a project (moves its real folder to the
  // macOS Trash) — the one action here that touches real filesystem state outside sync-hub's own
  // store, left as a dashboard-only action with its own explicit confirmation UI.

  server.registerTool(
    'manage_project',
    {
      title: 'Gérer un projet — renommer, catégoriser, fusionner, archiver, gérer les catégories',
      description:
        'Un seul outil pour les actions de gestion sur les projets sync-hub — choisis `action`, puis renseigne les champs ' +
        "pertinents pour cette action (les autres sont ignorés) :\n" +
        '- rename: project, name — change le nom affiché, ne touche ni le chemin réel ni les fils\n' +
        '- set_category: project, category (null pour retirer) — catégorie libre pour le regroupement dans le dashboard ' +
        '("ekonum", "client", "perso" au minimum, mais toute étiquette est acceptée ; jamais deviné, appelle list_categories ' +
        "avant pour réutiliser l'orthographe exacte plutôt que d'en recréer une variante par erreur)\n" +
        '- merge: source, target — déplace tous les fils/mémoires/artefacts de source vers target (qui garde son nom) ; ' +
        'fusion pure côté enregistrements, aucun fichier réel touché, irréversible en un clic\n' +
        "- archive: project — masque le projet du dashboard et archive chacun de ses fils encore actifs\n" +
        '- list_categories: (aucun champ) — toutes les catégories connues avec leur nombre de projets\n' +
        "- create_category: name — enregistre une catégorie même avant qu'un projet l'utilise\n" +
        "- rename_category: name (actuel), newName — renomme partout à la fois, elle-même et tous les projets qui l'utilisent\n" +
        '- delete_category: name — les projets qui l\'utilisaient repassent sans catégorie, jamais rattachés à une autre au hasard',
      inputSchema: {
        action: z
          .enum(['rename', 'set_category', 'merge', 'archive', 'list_categories', 'create_category', 'rename_category', 'delete_category'])
          .describe("L'action à effectuer"),
        project: z.string().optional().describe('Id ou nom du projet — actions rename, set_category, archive'),
        name: z.string().optional().describe('rename: nouveau nom du projet · create_category: nom de la catégorie · rename_category: son nom actuel'),
        category: z.string().nullable().optional().describe('set_category: étiquette à assigner, ou null pour retirer'),
        newName: z.string().optional().describe('rename_category: nouveau nom de la catégorie'),
        source: z.string().optional().describe('merge: id ou nom du projet à absorber (disparaît après fusion)'),
        target: z.string().optional().describe('merge: id ou nom du projet qui reçoit tout et garde son nom'),
      },
    },
    logged(db, 'manage_project', async (input: any) => {
      switch (input.action) {
        case 'rename': {
          const project = resolveProject(db, input.project ?? '');
          if (!project) return { content: [{ type: 'text', text: projectNotFoundText(db, input.project ?? '') }], isError: true };
          if (!input.name?.trim()) return { content: [{ type: 'text', text: 'action rename : `name` est requis.' }], isError: true };
          db.renameProject(project.id, input.name.trim());
          updatePointerFiles(db, db.getProject(project.id)!);
          return { content: [{ type: 'text', text: `"${project.name}" renommé en "${input.name.trim()}".` }] };
        }
        case 'set_category': {
          const project = resolveProject(db, input.project ?? '');
          if (!project) return { content: [{ type: 'text', text: projectNotFoundText(db, input.project ?? '') }], isError: true };
          const trimmed = input.category?.trim() || null;
          db.setProjectCategory(project.id, trimmed);
          return {
            content: [{ type: 'text', text: trimmed ? `"${project.name}" classé dans "${trimmed}".` : `"${project.name}" retiré de sa catégorie.` }],
          };
        }
        case 'merge': {
          if (!input.source || !input.target) {
            return { content: [{ type: 'text', text: 'action merge : `source` et `target` sont requis.' }], isError: true };
          }
          const sourceProject = resolveProject(db, input.source);
          const targetProject = resolveProject(db, input.target);
          if (!sourceProject) return { content: [{ type: 'text', text: projectNotFoundText(db, input.source) }], isError: true };
          if (!targetProject) return { content: [{ type: 'text', text: projectNotFoundText(db, input.target) }], isError: true };
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
        }
        case 'archive': {
          const project = resolveProject(db, input.project ?? '');
          if (!project) return { content: [{ type: 'text', text: projectNotFoundText(db, input.project ?? '') }], isError: true };
          if (project.id === UNASSIGNED_PROJECT_ID) {
            return { content: [{ type: 'text', text: 'Le projet "unassigned" ne peut pas être archivé.' }], isError: true };
          }
          const results = db
            .getThreadsForProject(project.id)
            .filter((t) => t.status === 'active')
            .map((t) => archiveThread(db, t, archiveRoots));
          db.setProjectArchived(project.id, true);
          return { content: [{ type: 'text', text: `"${project.name}" archivé (${results.length} fil(s) traité(s)).` }] };
        }
        case 'list_categories': {
          const categories = db.listCategories();
          if (categories.length === 0) return { content: [{ type: 'text', text: 'Aucune catégorie pour le moment.' }] };
          return {
            content: [{ type: 'text', text: categories.map((c) => `${c.name} (${c.projectCount} projet${c.projectCount === 1 ? '' : 's'})`).join('\n') }],
          };
        }
        case 'create_category': {
          if (!input.name?.trim()) return { content: [{ type: 'text', text: 'action create_category : `name` est requis.' }], isError: true };
          db.createCategory(input.name.trim());
          return { content: [{ type: 'text', text: `Catégorie "${input.name.trim()}" prête.` }] };
        }
        case 'rename_category': {
          if (!input.name || !input.newName?.trim()) {
            return { content: [{ type: 'text', text: 'action rename_category : `name` et `newName` sont requis.' }], isError: true };
          }
          try {
            db.renameCategory(input.name, input.newName.trim());
          } catch (err: any) {
            return { content: [{ type: 'text', text: err.message }], isError: true };
          }
          return { content: [{ type: 'text', text: `"${input.name}" renommée en "${input.newName.trim()}".` }] };
        }
        case 'delete_category': {
          if (!input.name) return { content: [{ type: 'text', text: 'action delete_category : `name` est requis.' }], isError: true };
          const affected = db.deleteCategory(input.name);
          return {
            content: [
              { type: 'text', text: `Catégorie "${input.name}" supprimée (${affected} projet${affected === 1 ? '' : 's'} repassé${affected === 1 ? '' : 's'} sans catégorie).` },
            ],
          };
        }
        default:
          return { content: [{ type: 'text', text: `action inconnue : "${input.action}".` }], isError: true };
      }
    }),
  );

  server.registerTool(
    'manage_thread',
    {
      title: 'Gérer un fil — rattacher, archiver, supprimer, délier',
      description:
        'Un seul outil pour les actions de gestion sur un fil précis — choisis `action`, threadId, et project si besoin :\n' +
        "- assign: threadId, project — l'action de triage principale pour les fils \"unassigned\" ; si le fil a une référence " +
        'native connue (slug Claude Code, cwd Codex), sync-hub apprend aussi cette référence pour ce projet\n' +
        "- archive: threadId — déplace le fichier source réel (jamais supprimé) et masque le fil par défaut ; un fil sans " +
        'fichier source réel (import en masse) est archivé côté enregistrements sync-hub uniquement\n' +
        '- delete: threadId — retire le fil de sync-hub (base et dashboard), réellement absent ensuite ; le fichier source ' +
        'réel n\'est jamais supprimé (même traitement que archive) ; pour un import en doublon ou un fil de test\n' +
        '- unlink: threadId — retire le fil de son groupe de fils liés (voir link_threads) ; dissout le groupe entier si ' +
        "moins de deux fils restent ; sans effet si le fil n'était lié à rien",
      inputSchema: {
        action: z.enum(['assign', 'archive', 'delete', 'unlink']).describe("L'action à effectuer"),
        threadId: z.string().describe('Id du fil concerné'),
        project: z.string().optional().describe('Id ou nom du projet cible — action assign uniquement'),
      },
    },
    logged(db, 'manage_thread', async (input: any) => {
      switch (input.action) {
        case 'assign': {
          const thread = db.getThread(input.threadId);
          if (!thread) return { content: [{ type: 'text', text: `Aucun fil avec l'id "${input.threadId}".` }], isError: true };
          if (!input.project) return { content: [{ type: 'text', text: 'action assign : `project` est requis.' }], isError: true };
          const target = resolveProject(db, input.project);
          if (!target) return { content: [{ type: 'text', text: projectNotFoundText(db, input.project) }], isError: true };

          if (thread.sourceRef) {
            const kind = thread.originEngine === 'claude-code' ? 'claudeSlugs' : thread.originEngine === 'codex' ? 'codexCwds' : null;
            if (kind) registry.assign(target.id, kind, thread.sourceRef);
          }
          db.reassignThread(thread.id, target.id);
          updatePointerFiles(db, target);
          return { content: [{ type: 'text', text: `"${thread.title}" rattaché à "${target.name}".` }] };
        }
        case 'archive': {
          const thread = db.getThread(input.threadId);
          if (!thread) return { content: [{ type: 'text', text: `Aucun fil avec l'id "${input.threadId}".` }], isError: true };
          const result = archiveThread(db, thread, archiveRoots);
          return { content: [{ type: 'text', text: `"${thread.title}" — ${result.note}` }] };
        }
        case 'delete': {
          const thread = db.getThread(input.threadId);
          if (!thread) return { content: [{ type: 'text', text: `Aucun fil avec l'id "${input.threadId}".` }], isError: true };
          const result = deleteThread(db, thread, archiveRoots);
          return { content: [{ type: 'text', text: `"${thread.title}" — ${result.note}` }] };
        }
        case 'unlink': {
          if (!db.getThread(input.threadId)) {
            return { content: [{ type: 'text', text: `Aucun fil avec l'id "${input.threadId}".` }], isError: true };
          }
          const hadLink = !!db.getThreadLink(input.threadId);
          db.unlinkThread(input.threadId);
          return { content: [{ type: 'text', text: hadLink ? 'Fil délié.' : "Ce fil n'était lié à rien." }] };
        }
        default:
          return { content: [{ type: 'text', text: `action inconnue : "${input.action}".` }], isError: true };
      }
    }),
  );

  return server;
}
