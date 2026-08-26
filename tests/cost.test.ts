import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { computeCostSummary } from '../src/core/cost.js';
import type { Message, Project } from '../src/types.js';

let dir: string;
let db: Db;

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-a',
    name: 'A',
    canonicalPath: '/tmp/a',
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
    projectId: 'proj-a',
    sourceEngine: 'claude-code',
    role: 'assistant',
    content: 'x',
    timestamp: now,
    sequence: 0,
    hash: 'h1',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-cost-'));
  db = new Db(join(dir, 'hub.sqlite'));
  db.upsertProject(project());
  db.upsertProject(project({ id: 'proj-b', name: 'B', canonicalPath: '/tmp/b' }));
  db.upsertThread({
    id: 't1',
    projectId: 'proj-a',
    title: 'T',
    originEngine: 'claude-code',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });
  db.upsertThread({
    id: 't2',
    projectId: 'proj-b',
    title: 'T2',
    originEngine: 'codex',
    engineIds: {},
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('computeCostSummary', () => {
  it('sums real usage into an estimated cost, grouped by model, scoped to the requested project', () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
    db.insertMessage(message({ id: 'm2', hash: 'h2', model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
    db.insertMessage(
      message({ id: 'm3', hash: 'h3', threadId: 't2', projectId: 'proj-b', sourceEngine: 'codex', model: 'gpt-5.5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    );

    const summaryA = computeCostSummary(db, { projectId: 'proj-a' });
    expect(summaryA.totalCostUsd).toBeCloseTo(4, 10); // 2 x $2/MTok input
    expect(summaryA.totalCostEur).toBeCloseTo(4 * 0.92, 10);
    expect(summaryA.byModel[0]).toMatchObject({ model: 'claude-sonnet-5', costUsd: 4, inputTokens: 2_000_000, outputTokens: 0, messageCount: 2, provider: 'Anthropic' });
    expect(summaryA.unpricedMessageCount).toBe(0);

    const summaryB = computeCostSummary(db, { projectId: 'proj-b' });
    expect(summaryB.totalCostUsd).toBeCloseTo(5, 10); // $5/MTok input for gpt-5.5
    expect(summaryB.byEngine[0]).toMatchObject({ engine: 'codex', provider: 'OpenAI', costUsd: 5 });
  });

  it('counts messages with a real model+usage but no price entry as unpriced, never as $0', () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', model: 'some-future-model-not-in-the-table', usage: { inputTokens: 100, outputTokens: 10 } }));
    const summary = computeCostSummary(db, { projectId: 'proj-a' });
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.unpricedMessageCount).toBe(1);
    expect(summary.byModel).toHaveLength(0);
  });

  it('ignores messages with no recorded model/usage at all (nothing to price, not zero-cost)', () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1' })); // no model, no usage
    const summary = computeCostSummary(db, { projectId: 'proj-a' });
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.unpricedMessageCount).toBe(0);
  });

  it('with no scope, aggregates across the whole store', () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
    db.insertMessage(
      message({ id: 'm3', hash: 'h3', threadId: 't2', projectId: 'proj-b', sourceEngine: 'codex', model: 'gpt-5.5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    );
    const summary = computeCostSummary(db);
    expect(summary.totalCostUsd).toBeCloseTo(7, 10); // $2 + $5
    expect(summary.byModel).toHaveLength(2);
  });

  it('scopes to a single thread when threadId is given', () => {
    db.insertMessage(message({ id: 'm1', hash: 'h1', model: 'claude-sonnet-5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }));
    db.insertMessage(
      message({ id: 'm2', hash: 'h2', threadId: 't2', projectId: 'proj-b', sourceEngine: 'codex', model: 'gpt-5.5', usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    );
    expect(computeCostSummary(db, { threadId: 't1' }).totalCostUsd).toBeCloseTo(2, 10);
  });
});
