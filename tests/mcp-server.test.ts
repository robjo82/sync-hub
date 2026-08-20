import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Db } from '../src/core/db.js';
import { createMcpServer } from '../src/core/mcp-server.js';
import type { Message, Project } from '../src/types.js';

let dir: string;
let db: Db;
let client: Client;

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-demo',
    name: 'demo',
    canonicalPath: '/Users/robin/Projets/demo',
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] },
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: 'm1',
    threadId: 't1',
    projectId: 'proj-demo',
    sourceEngine: 'claude-code',
    role: 'user',
    content: 'Bonjour',
    timestamp: now,
    sequence: 0,
    hash: 'h1',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-mcp-'));
  db = new Db(join(dir, 'hub.sqlite'));
  db.upsertProject(project());
  db.upsertThread({
    id: 't1',
    projectId: 'proj-demo',
    title: 'Fil',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });
  db.upsertThread({
    id: 't2',
    projectId: 'proj-demo',
    title: 'Fil 2',
    originEngine: 'codex',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });

  const server = createMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sync-hub MCP server', () => {
  it('exposes get_project_timeline, get_thread, link_threads, unlink_thread, get_thread_link_updates and search_transcripts', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_project_timeline',
      'get_thread',
      'get_thread_link_updates',
      'link_threads',
      'search_transcripts',
      'unlink_thread',
    ]);
  });

  it('get_thread fetches one specific thread by id, verbatim — the way to resume a single imported conversation', async () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', sequence: 0, content: 'Reprends cette conversation précise.' }));
    const result = await client.callTool({ name: 'get_thread', arguments: { threadId: 't1' } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain('Reprends cette conversation précise.');
    expect(text).toContain('Fil'); // includes the thread title for context
  });

  it('get_thread reports an error for an unknown thread id', async () => {
    const result = await client.callTool({ name: 'get_thread', arguments: { threadId: 'does-not-exist' } });
    expect(result.isError).toBe(true);
  });

  it('get_project_timeline returns verbatim content, not a summary', async () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', sequence: 0, content: 'Le texte exact du message, verbatim.' }));

    const result = await client.callTool({ name: 'get_project_timeline', arguments: { project: 'proj-demo' } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain('Le texte exact du message, verbatim.');
  });

  it('resolves a project by human-readable name as well as by id', async () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', sequence: 0, content: 'via nom' }));
    const result = await client.callTool({ name: 'get_project_timeline', arguments: { project: 'demo' } });
    expect((result.content as any[])[0].text).toContain('via nom');
  });

  it('reports an error with the list of known projects when the project is unknown', async () => {
    const result = await client.callTool({ name: 'get_project_timeline', arguments: { project: 'ne-existe-pas' } });
    expect(result.isError).toBe(true);
    expect((result.content as any[])[0].text).toContain('proj-demo');
  });

  it('filters by `since`', async () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', sequence: 0, timestamp: '2026-01-01T00:00:00Z', content: 'ancien' }));
    db.insertMessage(message({ id: 'm2', hash: 'h2', sequence: 1, timestamp: '2026-01-02T00:00:00Z', content: 'récent' }));

    const result = await client.callTool({
      name: 'get_project_timeline',
      arguments: { project: 'proj-demo', since: '2026-01-01T12:00:00Z' },
    });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain('récent');
    expect(text).not.toContain('ancien');
  });

  it('search_transcripts finds a substring across messages and reports which project it came from', async () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', sequence: 0, content: "problème de balance comptable chez Acritec" }));
    const result = await client.callTool({ name: 'search_transcripts', arguments: { query: 'balance comptable' } });
    const text = (result.content as any[])[0].text as string;
    expect(text).toContain('balance comptable');
    expect(text).toContain('demo'); // project name surfaced alongside the match
  });

  describe('link_threads / get_thread_link_updates', () => {
    it('links two threads and confirms it with their titles', async () => {
      const result = await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1', 't2'] } });
      const text = (result.content as any[])[0].text as string;
      expect(text).toContain('2 fils liés');
      expect(text).toContain('Fil');
      expect(text).toContain('Fil 2');
    });

    it('reports an error for a single thread id instead of silently doing nothing', async () => {
      const result = await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1'] } });
      expect(result.isError).toBe(true);
    });

    it('reports an error for an unknown thread id — never guesses a match', async () => {
      const result = await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1', 'does-not-exist'] } });
      expect(result.isError).toBe(true);
    });

    it('get_thread_link_updates says so for an unlinked thread, rather than erroring or guessing', async () => {
      const result = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 't1' } });
      expect(result.isError).toBeFalsy();
      expect((result.content as any[])[0].text).toContain('aucun groupe');
    });

    it('get_thread_link_updates returns verbatim messages from the OTHER linked thread only, then only the delta on the next call', async () => {
      await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1', 't2'] } });
      db.insertMessage(message({ id: 'm1', threadId: 't2', hash: 'h1', timestamp: '2026-01-01T00:00:00Z', content: 'premier message du fil 2' }));

      const first = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 't1' } });
      expect((first.content as any[])[0].text).toContain('premier message du fil 2');

      const second = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 't1' } });
      expect((second.content as any[])[0].text).toContain('Rien de nouveau');

      db.insertMessage(message({ id: 'm2', threadId: 't2', hash: 'h2', timestamp: '2026-01-02T00:00:00Z', content: 'second message du fil 2' }));
      const third = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 't1' } });
      const thirdText = (third.content as any[])[0].text as string;
      expect(thirdText).toContain('second message du fil 2');
      expect(thirdText).not.toContain('premier message du fil 2'); // already consumed — delta only
    });

    it('get_thread_link_updates reports an error for an unknown thread id', async () => {
      const result = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 'does-not-exist' } });
      expect(result.isError).toBe(true);
    });

    it('unlink_thread removes a thread from its group, and get_thread_link_updates then reports it as unlinked', async () => {
      await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1', 't2'] } });
      const unlinkResult = await client.callTool({ name: 'unlink_thread', arguments: { threadId: 't1' } });
      expect((unlinkResult.content as any[])[0].text).toContain('délié');

      const after = await client.callTool({ name: 'get_thread_link_updates', arguments: { threadId: 't1' } });
      expect((after.content as any[])[0].text).toContain('aucun groupe');
    });

    it('unlink_thread on a thread that was never linked says so without erroring', async () => {
      const result = await client.callTool({ name: 'unlink_thread', arguments: { threadId: 't1' } });
      expect(result.isError).toBeFalsy();
      expect((result.content as any[])[0].text).toContain("n'était lié à rien");
    });

    it('unlink_thread reports an error for an unknown thread id', async () => {
      const result = await client.callTool({ name: 'unlink_thread', arguments: { threadId: 'does-not-exist' } });
      expect(result.isError).toBe(true);
    });
  });

  describe('MCP call log — so a real problem can be traced after the fact', () => {
    it('records a successful call, verbatim params and a summary of what was returned', async () => {
      await client.callTool({ name: 'get_thread', arguments: { threadId: 't1' } });
      const calls = db.getRecentMcpCalls();
      expect(calls[0]).toMatchObject({ tool: 'get_thread', params: { threadId: 't1' }, isError: false });
      expect(calls[0].summary).toBeTruthy();
    });

    it('records a failed call as an error, distinctly from a successful one', async () => {
      await client.callTool({ name: 'get_thread', arguments: { threadId: 'does-not-exist' } });
      expect(db.getRecentMcpCalls()[0]).toMatchObject({ tool: 'get_thread', isError: true });
    });

    it('records every distinct tool call — not just one', async () => {
      await client.callTool({ name: 'get_thread', arguments: { threadId: 't1' } });
      await client.callTool({ name: 'link_threads', arguments: { threadIds: ['t1', 't2'] } });
      const tools = db.getRecentMcpCalls().map((c) => c.tool);
      expect(tools).toEqual(['link_threads', 'get_thread']); // newest first
    });
  });
});
