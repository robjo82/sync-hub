import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from './db.js';
import type { Message, Project } from '../types.js';

const ENGINE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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
export function createMcpServer(db: Db): McpServer {
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

  return server;
}
