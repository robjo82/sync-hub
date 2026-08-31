import { describe, expect, it } from 'vitest';
import {
  formatThreadAsJson,
  formatThreadAsMarkdown,
  formatProjectAsMarkdown,
  formatProjectAsJson,
  sanitizeFilename,
} from '../src/core/export.js';
import type { Message, Project, Thread } from '../src/types.js';

describe('export helpers', () => {
  const mockProject: Project = {
    id: 'proj-1',
    name: 'Projet Test',
    canonicalPath: '/path/to/test',
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: '2026-08-28T10:00:00Z',
    lastActiveAt: '2026-08-28T12:00:00Z',
  };

  const mockThread: Thread = {
    id: 't-1',
    projectId: 'proj-1',
    title: 'Discussion sur l\'architecture',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 2,
    createdAt: '2026-08-28T10:00:00Z',
    updatedAt: '2026-08-28T12:00:00Z',
    status: 'active',
  };

  const mockMessages: Message[] = [
    {
      id: 'm-1',
      threadId: 't-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'user',
      content: 'Comment configurer SQLite ?',
      timestamp: '2026-08-28T10:00:00Z',
      sequence: 0,
      hash: 'h-1',
      estimatedTokens: 10,
    },
    {
      id: 'm-2',
      threadId: 't-1',
      projectId: 'proj-1',
      sourceEngine: 'claude-code',
      role: 'assistant',
      thought: 'Analysons les pragmas SQLite.',
      content: 'Utilisez WAL mode et busy_timeout.',
      timestamp: '2026-08-28T10:01:00Z',
      sequence: 1,
      hash: 'h-2',
      estimatedTokens: 25,
    },
  ];

  it('sanitizes filename correctly', () => {
    expect(sanitizeFilename('Discussion & Test / Résultat !')).toBe('discussion-test-resultat');
    expect(sanitizeFilename('')).toBe('conversation');
  });

  it('formats thread as markdown with metadata and thoughts', () => {
    const md = formatThreadAsMarkdown(mockThread, mockProject, mockMessages);
    expect(md).toContain('# Discussion sur l\'architecture');
    expect(md).toContain('**Projet** : Projet Test');
    expect(md).toContain('**Moteur d\'origine** : Claude Code');
    expect(md).toContain('👤 Utilisateur');
    expect(md).toContain('Comment configurer SQLite ?');
    expect(md).toContain('🤖 Assistant (Claude Code)');
    expect(md).toContain('Analysons les pragmas SQLite.');
    expect(md).toContain('Utilisez WAL mode et busy_timeout.');
    expect(md).toContain('Sync Hub');
  });

  it('formats thread as valid JSON', () => {
    const jsonStr = formatThreadAsJson(mockThread, mockProject, mockMessages);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe('1.0');
    expect(parsed.thread.id).toBe('t-1');
    expect(parsed.project.name).toBe('Projet Test');
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].thought).toBe('Analysons les pragmas SQLite.');
  });

  it('formats project as markdown with TOC and threads', () => {
    const md = formatProjectAsMarkdown(mockProject, [{ thread: mockThread, messages: mockMessages }]);
    expect(md).toContain('# Projet : Projet Test');
    expect(md).toContain('**Chemin canonique** : `/path/to/test`');
    expect(md).toContain('## Sommaire des conversations');
    expect(md).toContain('1. [Discussion sur l\'architecture](#thread-t-1)');
    expect(md).toContain('👤 Utilisateur');
    expect(md).toContain('Comment configurer SQLite ?');
  });

  it('formats project as valid JSON with stats', () => {
    const jsonStr = formatProjectAsJson(mockProject, [{ thread: mockThread, messages: mockMessages }]);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe('1.0');
    expect(parsed.project.id).toBe('proj-1');
    expect(parsed.stats.totalThreads).toBe(1);
    expect(parsed.stats.totalMessages).toBe(2);
    expect(parsed.threads[0].messages).toHaveLength(2);
  });
});
