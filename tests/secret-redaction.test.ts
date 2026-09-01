import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';

let dir: string;
let db: Db;
const SECRET = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-redact-'));
  db = new Db(join(dir, 'hub.sqlite'));
  const now = new Date().toISOString();
  db.upsertProject({ id: 'p1', name: 'P', canonicalPath: '/tmp/p', aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
  db.upsertThread({ id: 't1', projectId: 'p1', title: 'T', originEngine: 'claude-code', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addMessage(id: string, fields: { content?: string; thought?: string; toolResults?: string }) {
  db.insertMessage({
    id,
    threadId: 't1',
    projectId: 'p1',
    sourceEngine: 'claude-code',
    role: 'assistant',
    content: fields.content ?? '',
    thought: fields.thought,
    toolResults: fields.toolResults ? [{ toolCallId: 'c', name: 'bash', output: fields.toolResults, status: 'success' }] : undefined,
    timestamp: new Date().toISOString(),
    sequence: 0,
    hash: `h-${id}`,
  });
}

describe('scanForSecrets', () => {
  it('groups the same credential across messages instead of reporting it once per message', async () => {
    addMessage('m1', { content: `voici ${SECRET} pour le déploiement` });
    addMessage('m2', { content: `je réutilise ${SECRET} ici aussi` });

    const results = await db.scanForSecrets();
    const github = results.find((r) => r.kind === 'Jeton GitHub');
    expect(github).toBeDefined();
    expect(github!.occurrences).toBe(2);
    expect(github!.messageIds.sort()).toEqual(['m1', 'm2']);
  });

  it('never returns the plaintext — a review screen must not reprint what it is reporting', async () => {
    addMessage('m1', { content: `clé ${SECRET} ici` });
    const serialised = JSON.stringify(await db.scanForSecrets());
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain('ghp_aB');
  });

  it('looks in reasoning and tool output, not just the visible message', async () => {
    addMessage('m1', { content: 'rien ici', thought: `en fait la clé est ${SECRET}` });
    addMessage('m2', { content: 'ni là', toolResults: `export TOKEN=${SECRET}` });
    expect((await db.scanForSecrets()).find((r) => r.kind === 'Jeton GitHub')!.occurrences).toBe(2);
  });

  it('masks a second secret sitting in the context window, not only the one reported', async () => {
    const other = 'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    addMessage('m1', { content: `token=${SECRET} et aussi OPENAI_API_KEY=${other} dans la même ligne` });

    const serialised = JSON.stringify(await db.scanForSecrets());
    // Neither may appear in full: the excerpt around one finding routinely contains another.
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(other);
  });
});

describe('redactSecret', () => {
  it('removes every occurrence across every field, keeping the conversation readable', () => {
    addMessage('m1', { content: `déploie avec ${SECRET} stp`, thought: `la clé ${SECRET}` });
    addMessage('m2', { content: `et ${SECRET} encore` });

    const result = db.redactSecret(SECRET);
    expect(result.messagesChanged).toBe(2);
    expect(result.occurrences).toBe(3);

    const messages = db.getMessagesForThread('t1');
    expect(JSON.stringify(messages)).not.toContain(SECRET);
    expect(messages[0].content).toBe('déploie avec [secret retiré] stp');
    expect(messages[0].thought).toBe('la clé [secret retiré]');
  });

  it('takes the secret out of the search index too, or it stays findable by typing it', () => {
    addMessage('m1', { content: `la clé ${SECRET} est ici` });
    expect(db.searchTranscripts(SECRET, 10).length).toBeGreaterThan(0);

    db.redactSecret(SECRET);
    expect(db.searchTranscripts(SECRET, 10)).toHaveLength(0);
    // The rest of the message stays searchable — redaction is not deletion.
    expect(db.searchTranscripts('clé', 10).length).toBeGreaterThan(0);
  });

  it('leaves messages that never held the secret untouched', () => {
    addMessage('m1', { content: `avec ${SECRET}` });
    addMessage('m2', { content: 'une conversation parfaitement ordinaire' });

    db.redactSecret(SECRET);
    expect(db.getMessagesForThread('t1').find((m) => m.id === 'm2')!.content).toBe('une conversation parfaitement ordinaire');
  });

  it('is idempotent and safe on a value that is not present', () => {
    addMessage('m1', { content: `avec ${SECRET}` });
    db.redactSecret(SECRET);
    expect(db.redactSecret(SECRET)).toEqual({ messagesChanged: 0, occurrences: 0 });
    expect(db.redactSecret('')).toEqual({ messagesChanged: 0, occurrences: 0 });
  });

  it('reports nothing left to find once redacted', async () => {
    addMessage('m1', { content: `avec ${SECRET}` });
    db.redactSecret(SECRET);
    expect((await db.scanForSecrets()).find((r) => r.kind === 'Jeton GitHub')).toBeUndefined();
  });
});
