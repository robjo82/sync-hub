import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { computeMessageHash } from '../hash.js';
import type { Message, MessageRole, Thread } from '../../types.js';
import { UNASSIGNED_PROJECT_ID } from '../../types.js';

/** Deterministic sync-hub project id for a ChatGPT Project — stable across re-scans. */
export function chatGptProjectSyncHubId(templateId: string): string {
  return `chatgpt-project-${templateId}`;
}

/** Every project's chatgptProjectIds aliases, flattened to a single template-id → project-id map. */
export function buildChatGptTemplateIdMap(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of db.getProjects()) {
    for (const templateId of p.aliases.chatgptProjectIds ?? []) map.set(templateId, p.id);
  }
  return map;
}

/**
 * A ChatGPT Project (e.g. "C00125 - Acritec") becomes a real sync-hub project — appearing in the
 * project list, not just a title prefix on otherwise-standalone unassigned threads — so client
 * work is actually grouped and browsable, matching how a real folder-backed project works. It has
 * no real folder (`canonicalPath` is a synthetic, never-existing marker, distinct per project so
 * it doesn't collide with the UNIQUE constraint every other synthetic entry also relies on),
 * which naturally makes pointer-file writes a no-op for it (nothing on disk to write into).
 *
 * `templateIdToProjectId` maps a ChatGPT template id to whatever project currently claims it —
 * itself by default, or a different (real) project it was folded into via a manual merge. Seeded
 * once per ingest run and consulted here so a merge survives future re-scans instead of the
 * deterministic `chatgpt-project-<templateId>` id silently reappearing. Omit it (e.g. when calling
 * from a single-session context rather than a batch import) to build it fresh on the spot.
 */
export function ensureChatGptProject(db: Db, templateId: string, name: string, now: string, templateIdToProjectId?: Map<string, string>): string {
  const claimedBy = (templateIdToProjectId ?? buildChatGptTemplateIdMap(db)).get(templateId);
  if (claimedBy) return claimedBy;

  const id = chatGptProjectSyncHubId(templateId);
  if (!db.getProject(id)) {
    db.upsertProject({
      id,
      name,
      canonicalPath: `chatgpt-project://${templateId}`,
      aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
      createdAt: now,
      lastActiveAt: now,
    });
  }
  templateIdToProjectId?.set(templateId, id);
  return id;
}

interface ChatGptContentPart {
  content_type?: string;
  [key: string]: unknown;
}

interface ChatGptMessage {
  id: string;
  author: { role: string; name?: string | null };
  content: {
    content_type: string;
    parts?: Array<string | ChatGptContentPart>;
    thoughts?: Array<{ content?: string }>;
  };
  create_time: number | null;
}

interface ChatGptNode {
  id: string;
  message?: ChatGptMessage | null;
  parent?: string | null;
}

interface ChatGptConversation {
  id: string;
  conversation_id: string;
  title: string;
  create_time: number;
  update_time?: number | null;
  current_node: string;
  mapping: Record<string, ChatGptNode>;
  /** ChatGPT's own "Project" grouping (its ids look like "g-p-<hex>") — null/absent for ungrouped conversations. */
  conversation_template_id?: string | null;
}

export const CHATGPT_PROJECTS_CACHE_ROOT = join(homedir(), '.codex', '.chatgpt-projects');

/**
 * ChatGPT Projects have no human-readable name anywhere in the bulk export itself — only the
 * opaque `g-p-<hex>` id. Codex's own local cache of ChatGPT Projects (populated whenever one was
 * used to launch a Codex task) happens to keep the real name in a generated AGENTS.md file, e.g.
 * "This directory is a local mirror of the ChatGPT project "C00125 - Acritec"." This is a partial
 * lookup (only covers projects Codex has seen), not exhaustive — an unresolvable id just falls
 * back to being shown as-is rather than guessed at.
 */
export function loadChatGptProjectNames(cacheRoot: string = CHATGPT_PROJECTS_CACHE_ROOT): Map<string, string> {
  const names = new Map<string, string>();
  if (!existsSync(cacheRoot)) return names;
  for (const entry of readdirSync(cacheRoot)) {
    if (!entry.startsWith('g-p-')) continue;
    const agentsPath = join(cacheRoot, entry, 'AGENTS.md');
    if (!existsSync(agentsPath)) continue;
    try {
      const content = readFileSync(agentsPath, 'utf-8');
      const match = content.match(/local mirror of the ChatGPT project [“"]([^”"]+)[”"]/);
      if (match) names.set(entry, match[1]);
    } catch {
      // unreadable — just skip, this cache is a best-effort convenience, not load-bearing
    }
  }
  return names;
}

/**
 * ChatGPT exports the conversation as a tree (`mapping`, keyed by node id, linked only by
 * `parent` — there is no forward `children` pointer). `current_node` is the tip of the branch
 * the user actually saw; walking `parent` back from there to the root reconstructs exactly that
 * linear conversation, matching the ChatGPT UI (any abandoned edit/regenerate branches along the
 * way are real but not part of what was actually read, so they're intentionally excluded).
 */
function walkLinearPath(conv: ChatGptConversation): ChatGptNode[] {
  const nodes: ChatGptNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = conv.current_node;
  while (cursor && conv.mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    const node: ChatGptNode = conv.mapping[cursor];
    nodes.push(node);
    cursor = node.parent;
  }
  return nodes.reverse();
}

/**
 * Content types verified against a full real export (5164 conversations / 82738 nodes, spanning
 * years of usage): 'text', 'multimodal_text', 'thoughts', 'reasoning_recap'. Anything else is
 * skipped rather than guessed at.
 */
function toCanonicalMessage(node: ChatGptNode, threadId: string, projectId: string, sequence: number): Message | null {
  const msg = node.message;
  if (!msg) return null; // structural node with no content (e.g. the tree root)

  const role: MessageRole | null = msg.author.role === 'user' ? 'user' : msg.author.role === 'assistant' ? 'assistant' : null;
  if (!role) return null;

  const content = msg.content;
  let text = '';
  let thought: string | undefined;

  switch (content.content_type) {
    case 'text':
    case 'multimodal_text':
      text = (content.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n');
      break;
    case 'thoughts':
      thought = (content.thoughts ?? [])
        .map((t) => t.content)
        .filter((c): c is string => !!c)
        .join('\n\n');
      break;
    case 'reasoning_recap':
      return null; // a UI timer label ("Réflexion durant 1m 27s"), not real content
    default:
      return null;
  }

  if (!text && !thought) return null;

  const hash = computeMessageHash(role, text, thought);
  const timestamp = msg.create_time ? new Date(msg.create_time * 1000).toISOString() : new Date(0).toISOString();
  // Scoped to threadId by construction rather than trusting msg.id to be globally unique on its
  // own — ChatGPT's node ids are UUIDs in practice, but nothing guarantees that across every
  // conversation in an export, and a collision would crash the whole import on a PRIMARY KEY hit.
  const id = createHash('sha256')
    .update(`${threadId}:${msg.id ?? sequence}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    threadId,
    projectId,
    sourceEngine: 'codex', // this content came from OpenAI, delivered via the ChatGPT web app
    role,
    content: text,
    thought,
    timestamp,
    sequence,
    hash,
    metadata: { imported: true, source: 'chatgpt-export' },
  };
}

/**
 * A `thoughts` node is ChatGPT's reasoning trace for the reply that immediately follows it in the
 * conversation tree — as far as the user is concerned that reasoning IS part of the reply, not a
 * separate message, so it's folded into the next message's `thought` field here rather than
 * counted on its own (the same treatment Codex's `reasoning` response_items get).
 */
function mergeThoughtsIntoFollowingMessage(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: string | undefined;

  for (const m of messages) {
    const isThoughtOnly = !m.content && m.thought && !m.toolCalls && !m.toolResults;
    if (isThoughtOnly) {
      pending = pending ? `${pending}\n\n${m.thought}` : m.thought;
      continue;
    }
    if (pending) {
      out.push({ ...m, thought: m.thought ? `${pending}\n\n${m.thought}` : pending });
      pending = undefined;
    } else {
      out.push(m);
    }
  }
  if (pending) {
    const last = messages[messages.length - 1];
    out.push({ ...last, id: `${last.id}-thought`, content: '', thought: pending, hash: computeMessageHash('assistant', '', pending) });
  }
  return out;
}

/**
 * One-shot bulk import of a ChatGPT "Export data" archive — sharded across conversations-NNN.json
 * files (not a single conversations.json like Claude's export). Never watched live.
 */
export function ingestChatGptExport(db: Db, exportDir: string, projectsCacheRoot: string = CHATGPT_PROJECTS_CACHE_ROOT): number {
  if (!existsSync(exportDir)) return 0;
  const shardFiles = readdirSync(exportDir)
    .filter((f) => /^conversations-\d+\.json$/.test(f))
    .sort();
  if (shardFiles.length === 0) return 0;

  const projectNames = loadChatGptProjectNames(projectsCacheRoot);
  // Seeded from every project's known chatgptProjectIds aliases (see mergeProjects in db.ts) so a
  // merge made via the dashboard is respected for the rest of this run and any future one.
  const templateIdToProjectId = buildChatGptTemplateIdMap(db);
  let inserted = 0;
  for (const shardFile of shardFiles) {
    const filePath = join(exportDir, shardFile);
    let conversations: ChatGptConversation[];
    try {
      conversations = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err: any) {
      db.logIngestEvent({
        engine: 'codex',
        filePath,
        eventType: 'full_scan',
        status: 'error',
        message: err?.message,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    for (const conv of conversations) {
      // A tiny fraction of real exports contain an empty `{}` stub (verified: 1 in 5164 in a
      // real account's export) — skip rather than crash on records with no usable identity.
      if (!conv.id || !conv.mapping) continue;

      const threadId = `chatgpt-export-${conv.id}`;
      const existingThread = db.getThread(threadId);
      const createdAt = conv.create_time ? new Date(conv.create_time * 1000).toISOString() : new Date().toISOString();
      // ChatGPT's real per-conversation last-activity timestamp — using create_time here too would
      // sort every imported thread by when it was *started*, not last touched.
      const updatedAt = conv.update_time ? new Date(conv.update_time * 1000).toISOString() : createdAt;
      const templateId = conv.conversation_template_id ?? undefined;
      const fallbackTitle = conv.title || `Session ${conv.id.slice(0, 8)}`;
      const title = `${fallbackTitle} (importé)`;

      // A ChatGPT Project becomes a real sync-hub project (grouped in the tree, not just a title
      // prefix) — but never overrides a manual triage assignment made via the dashboard. A thread
      // still sitting at the unassigned sentinel was never manually triaged (there is no dashboard
      // action that sends a thread back to "Non affecté"), so it's always safe to recompute it —
      // this lets threads imported before ChatGPT Project grouping existed get grouped retroactively.
      // When no cached AGENTS.md name exists (most ChatGPT Projects — verified: 38/46 in a real
      // export), fall back to the first real conversation title seen for it rather than the raw
      // "g-p-xxx" id — a real, verbatim label instead of an opaque hash, without inventing one.
      // Renameable later via the dashboard once the user recognizes it.
      const defaultProjectId = templateId
        ? ensureChatGptProject(db, templateId, projectNames.get(templateId) ?? fallbackTitle, updatedAt, templateIdToProjectId)
        : UNASSIGNED_PROJECT_ID;
      const projectId =
        existingThread && existingThread.projectId !== UNASSIGNED_PROJECT_ID ? existingThread.projectId : defaultProjectId;
      // Touch whichever project currently claims this template id — not the deterministic
      // chatgpt-project-<templateId> id, which no longer exists once merged into a different project.
      if (templateId) db.touchProjectActivity(templateIdToProjectId.get(templateId) ?? chatGptProjectSyncHubId(templateId), updatedAt);

      if (!existingThread) {
        db.upsertThread({
          id: threadId,
          projectId,
          title,
          originEngine: 'codex',
          engineIds: {},
          sourceRef: templateId,
          messageCount: 0,
          createdAt,
          updatedAt,
          status: 'active',
        } as Thread);
      }

      const rawMessages = walkLinearPath(conv)
        .map((node, i) => toCanonicalMessage(node, threadId, projectId, i))
        .filter((m): m is Message => m !== null);
      const messages = mergeThoughtsIntoFollowingMessage(rawMessages);

      let sequence = 0;
      for (const message of messages) {
        if (db.insertMessage({ ...message, sequence: sequence++ })) inserted++;
      }

      db.upsertThread({
        id: threadId,
        projectId,
        title,
        originEngine: 'codex',
        engineIds: {},
        sourceRef: templateId,
        messageCount: sequence,
        createdAt,
        updatedAt,
        status: 'active',
      } as Thread);
    }

    db.logIngestEvent({
      engine: 'codex',
      filePath,
      eventType: 'full_scan',
      status: 'ok',
      message: `${conversations.length} conversation(s) traitée(s)`,
      timestamp: new Date().toISOString(),
    });
  }

  return inserted;
}
