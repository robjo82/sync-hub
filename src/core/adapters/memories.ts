import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import { CLAUDE_CODE_STORAGE_ROOT } from './claude-code.js';
import type { Memory, MemoryCategory } from '../../types.js';

export const CODEX_MEMORIES_ROOT = join(homedir(), '.codex', 'memories');
const CODEX_ROLLOUT_SUMMARIES_DIR = join(CODEX_MEMORIES_ROOT, 'rollout_summaries');

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(['user', 'project', 'feedback', 'reference']);

/**
 * Claude Code memory files use proper `---`-delimited YAML frontmatter. Extracts a handful of
 * `key: value` lines from it, ignoring indentation/nesting — good enough to pull out `type`
 * without a real YAML parser.
 */
function parseYamlFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: raw };
  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^\s*(\w+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return { fields, body: body.trim() };
}

/**
 * Codex's rollout summaries have NO `---` delimiters — just plain `key: value` lines at the very
 * top of the file, terminated by the first blank line, before the free-form heading/body. Verified
 * against real files in ~/.codex/memories/rollout_summaries/ — do not assume a delimited format here.
 */
function parseLeadingFields(raw: string): { fields: Record<string, string>; body: string } {
  const lines = raw.split('\n');
  const fields: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) break;
    fields[m[1]] = m[2].trim();
  }
  return { fields, body: lines.slice(i).join('\n').trim() };
}

function fileHash(filePath: string, content: string): string {
  return createHash('sha256').update(`${filePath}\n${content}`).digest('hex').slice(0, 16);
}

/** `~/.claude/projects/<slug>/memory/*.md`, one per project — MEMORY.md itself is just an index, not a memory. */
export function ingestClaudeCodeMemories(db: Db, registry: ProjectRegistry, root: string = CLAUDE_CODE_STORAGE_ROOT): number {
  if (!existsSync(root)) return 0;
  let inserted = 0;
  for (const slug of readdirSync(root)) {
    const memoryDir = join(root, slug, 'memory');
    let files: string[];
    try {
      files = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      continue;
    }
    const projectId = registry.resolveByClaudeSlug(slug);
    for (const file of files) {
      const filePath = join(memoryDir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { fields, body } = parseYamlFrontmatter(raw);
      const category: MemoryCategory = KNOWN_CATEGORIES.has(fields.type) ? (fields.type as MemoryCategory) : 'other';
      const memory: Memory = {
        id: fileHash(filePath, raw),
        projectId,
        sourceEngine: 'claude-code',
        category,
        filePath,
        content: body || raw,
        lastModifiedAt: new Date().toISOString(),
      };
      db.upsertMemory(memory);
      inserted++;
    }
  }
  return inserted;
}

/**
 * Codex's memory system is organized around per-task "rollout summaries", each carrying an
 * explicit `cwd:` field — a more reliable project-association signal than Claude Code's memory
 * files, which have none and rely purely on the containing project's slug. `MEMORY.md` (a
 * cwd-scoped index of task groups) and `raw_memories.md` (an unstructured merge of the same
 * summaries) are both skipped in favor of the clean, individually-attributable summary files.
 */
export function ingestCodexMemories(db: Db, registry: ProjectRegistry, root: string = CODEX_ROLLOUT_SUMMARIES_DIR): number {
  if (!existsSync(root)) return 0;
  let inserted = 0;
  for (const file of readdirSync(root).filter((f) => f.endsWith('.md'))) {
    const filePath = join(root, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const { fields, body } = parseLeadingFields(raw);
    const projectId = fields.cwd ? registry.resolveByCodexCwd(fields.cwd) : 'unassigned';
    const memory: Memory = {
      id: fileHash(filePath, raw),
      projectId,
      sourceEngine: 'codex',
      category: 'project',
      filePath,
      content: body || raw,
      lastModifiedAt: new Date().toISOString(),
    };
    db.upsertMemory(memory);
    inserted++;
  }
  return inserted;
}

export function ingestAllMemories(db: Db, registry: ProjectRegistry): number {
  return ingestClaudeCodeMemories(db, registry) + ingestCodexMemories(db, registry);
}
