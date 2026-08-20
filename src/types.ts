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
}

/** Sentinel project id for sessions that could not be matched to a registry entry. */
export const UNASSIGNED_PROJECT_ID = 'unassigned';

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
