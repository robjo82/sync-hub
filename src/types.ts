export type EngineType = 'claude-code' | 'codex' | 'antigravity';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  status: 'success' | 'error';
  truncated?: boolean;
}

export interface Attachment {
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
}

/**
 * Real token counts as reported by the engine's own API response for the turn that produced this
 * message — never estimated or reconstructed. The cache/reasoning breakdown fields are each
 * present only when the source actually reports that field (they differ by provider — Claude
 * Code separates 5-minute vs 1-hour cache writes; Codex reports one combined cached-input figure
 * and a reasoning-token count that's already a subset of outputTokens, not additional).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  cacheReadInputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Verbatim, engine-agnostic envelope for one turn of conversation. Never paraphrased. */
export interface Message {
  id: string;
  threadId: string;
  projectId: string;
  sourceEngine: EngineType;
  role: MessageRole;
  content: string;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  attachments?: Attachment[];
  timestamp: string;
  sequence: number;
  /** SHA-256 over role+content+toolCalls+toolResults — the anti-duplicate-ingestion key. */
  hash: string;
  metadata?: Record<string, unknown>;
  /** The exact model id reported by the engine for this turn (e.g. "claude-sonnet-5", "gpt-5.5") — never inferred. */
  model?: string;
  usage?: TokenUsage;
  /** BPE-tokenizer token count of this message's own content+thought+tool payloads, computed once at ingest — only set for engines with no real token usage of their own (Antigravity), to back a cost *estimate*, never treated as real reported usage. */
  estimatedTokens?: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  originEngine: EngineType;
  engineIds: Partial<Record<EngineType, string>>;
  /** The raw cwd (Codex) or slug (Claude Code) that produced this thread — lets the triage UI teach the registry a real alias. */
  sourceRef?: string;
  /** Absolute path to the real session file this thread was ingested from, if any — lets archiving move the actual source file. */
  sourceFilePath?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'archived';
}

export interface ProjectAliases {
  /** Historical or alternate filesystem paths that should resolve to this project. */
  paths: string[];
  /** Claude Code project-folder slugs (e.g. "-Users-robin-Projets-odoo"). */
  claudeSlugs: string[];
  /** Codex cwd values known to belong to this project. */
  codexCwds: string[];
  /** ChatGPT "Project" template ids (e.g. "g-p-xxx") absorbed into this project via a merge. */
  chatgptProjectIds?: string[];
}

export interface Project {
  id: string;
  name: string;
  canonicalPath: string;
  aliases: ProjectAliases;
  createdAt: string;
  lastActiveAt: string;
  /** Hidden from the default dashboard view — sync-hub-side only, never touches the underlying project folder or session files. Defaults to false. */
  archived?: boolean;
  /** User-set manual position in the dashboard's project list (lower sorts first). Unset means "not manually positioned" — falls back to last-activity order. */
  sortOrder?: number | null;
  /** Free-form grouping label for the sidebar (e.g. "ekonum", "perso", "client") — never guessed, always explicitly set. Unset means ungrouped. */
  category?: string | null;
}

/** Sentinel project id for sessions that could not be matched to a registry entry. */
export const UNASSIGNED_PROJECT_ID = 'unassigned';

/** A known category name, independent of whether any project currently uses it (see Db.createCategory). */
export interface Category {
  name: string;
  projectCount: number;
}

/** Matches the real `metadata.type` values used by Claude Code's memory files, verbatim. */
export type MemoryCategory = 'user' | 'project' | 'feedback' | 'reference' | 'other';

export interface Memory {
  id: string;
  projectId: string;
  sourceEngine: EngineType;
  category: MemoryCategory;
  filePath: string;
  content: string;
  lastModifiedAt: string;
}

export type ArtifactType = 'implementation_plan' | 'walkthrough' | 'specification' | 'task' | 'document' | 'file_change';

export interface Artifact {
  id: string;
  projectId: string;
  threadId?: string;
  title: string;
  filePath: string;
  type: ArtifactType;
  content: string;
  sourceEngine: EngineType;
  createdAt: string;
}

export type IngestEventStatus = 'ok' | 'error' | 'skipped_duplicate';

export interface IngestLogEntry {
  id?: number;
  engine: EngineType;
  filePath: string;
  eventType: 'full_scan' | 'watch_tail';
  status: IngestEventStatus;
  message?: string;
  timestamp: string;
}

/** One recorded MCP tool call — verbatim params and a short outcome summary, for debugging. */
export interface McpCallLogEntry {
  id: number;
  tool: string;
  params: unknown;
  isError: boolean;
  summary?: string;
  timestamp: string;
}

export interface EngineHealth {
  engine: EngineType;
  storageRootExists: boolean;
  storageRoot: string;
  watcherActive: boolean;
  lastIngestAt: string | null;
  messageCount: number;
}

export interface SyncStats {
  totalProjects: number;
  totalThreads: number;
  totalMessages: number;
  totalMemories: number;
  totalArtifacts: number;
  unassignedThreadCount: number;
  engines: EngineHealth[];
}

export type WebSocketEvent =
  | { type: 'initial_state'; data: { projects: Project[]; stats: SyncStats } }
  | { type: 'new_message'; data: Message }
  | { type: 'thread_updated'; data: Thread }
  | { type: 'project_updated'; data: Project }
  | { type: 'stats_updated'; data: SyncStats };

/** Body of POST /api/sync/push — a batch of raw verbatim data pushed from one local sync-hub
 * instance to a remote hub it's configured to back up to (see core/sync-push-client.ts). */
export interface PushBatch {
  projects: Project[];
  threads: Thread[];
  messages: Message[];
}

export interface PushResult {
  ok: true;
  appliedProjects: number;
  appliedThreads: number;
  appliedMessages: number;
  skipped: { projects: string[]; threads: string[]; messages: string[] };
}

/** Response of GET /api/sync/pull — a batch of raw verbatim data pulled by a local sync-hub
 * instance from a remote hub (see core/sync-pull-client.ts). */
export interface PullBatch {
  projects: Project[];
  threads: Thread[];
  messages: Message[];
  maxSeq: number;
  hasMore: boolean;
}

export interface PullResult {
  ok: true;
  appliedProjects: number;
  appliedThreads: number;
  appliedMessages: number;
  skipped: { projects: string[]; threads: string[]; messages: string[] };
  newWatermark: number;
}

export interface RemoteSyncState {
  remoteUrl: string;
  lastPushedSeq: number;
  lastPushedAt: string | null;
  lastPulledSeq: number;
  lastPulledAt: string | null;
}

export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithPasswordHash extends User {
  passwordHash: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  /** SHA-256 of the token — the plaintext is shown once at creation and never stored. */
  tokenHash: string;
  /** Human label so a user can tell their machines apart when revoking ("MacBook Robin"). */
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  userAgent?: string;
  ip?: string;
}

export interface AuthStatus {
  authEnabled: boolean;
  setupRequired: boolean;
  user: User | null;
}

export interface SharedThread {
  id: string;
  threadId: string;
  shareToken: string;
  createdByUserId: string | null;
  title: string | null;
  isActive: boolean;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSharedThreadInput {
  threadId: string;
  title?: string;
  expiresAt?: string | null;
}

export interface UpdateSharedThreadInput {
  title?: string | null;
  isActive?: boolean;
  expiresAt?: string | null;
}

export interface PublicSharedThreadData {
  sharedThread: SharedThread;
  thread: Thread;
  messages: Message[];
  project: Project | null;
}

export interface DeviceSession {
  id: string;
  userId: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  expiresAt: string;
  isCurrent?: boolean;
  deviceLabel: string;
}

export interface AccountSyncOverview {
  user: User;
  devices: DeviceSession[];
}

export interface EngineStats {
  engine: EngineType;
  label: string;
  messageCount: number;
  threadCount: number;
  lastActiveAt: string | null;
}

export interface SyncOverview {
  remoteConfigured: boolean;
  remoteUrl: string | null;
  syncState: RemoteSyncState | null;
  accounts: AccountSyncOverview[];
  engines: EngineStats[];
  totalProjects: number;
  totalThreads: number;
  totalMessages: number;
}

