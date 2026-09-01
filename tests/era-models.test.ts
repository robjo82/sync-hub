import { describe, expect, it } from 'vitest';
import { modelForEra, providerForThread } from '../src/core/era-models.js';
import { hasPricing } from '../src/core/pricing.js';

describe('modelForEra', () => {
  it('picks the flagship in service on that date, not the newest ever', () => {
    expect(modelForEra('openai', '2023-06-01T10:00:00Z')).toBe('gpt-4');
    expect(modelForEra('openai', '2024-08-01T10:00:00Z')).toBe('gpt-4o');
    expect(modelForEra('openai', '2026-08-01T10:00:00Z')).toBe('gpt-5.5');
  });

  it('leaves a conversation older than any priced model uncounted', () => {
    // Robin's archive opens 2022-12-20; anything before the first entry gets no model rather
    // than being back-dated onto one that did not exist.
    expect(modelForEra('anthropic', '2023-01-01T10:00:00Z')).toBeNull();
  });

  it('switches on the release date, not near it', () => {
    expect(modelForEra('openai', '2025-08-06T23:59:59Z')).toBe('gpt-4.1');
    expect(modelForEra('openai', '2025-08-07T00:00:00Z')).toBe('gpt-5');
  });

  it('only names models the pricing table can actually price', () => {
    // An era entry pointing at an unpriced model would silently contribute nothing.
    for (const date of ['2022-12-20', '2023-06-01', '2024-01-15', '2024-08-01', '2025-06-01', '2026-08-17']) {
      const openai = modelForEra('openai', `${date}T12:00:00Z`);
      if (openai) expect(hasPricing(openai), `${openai} (${date})`).toBe(true);
      const anthropic = modelForEra('anthropic', `${date}T12:00:00Z`);
      if (anthropic) expect(hasPricing(anthropic), `${anthropic} (${date})`).toBe(true);
    }
  });

  it('reads the provider off the importer’s thread id', () => {
    expect(providerForThread('chatgpt-export-0010b82e')).toBe('openai');
    expect(providerForThread('claude-export-abc')).toBe('anthropic');
    expect(providerForThread('claude-code-session-xyz')).toBeNull();
  });
});

describe('archive upper bound in the cost summary', () => {
  it('stays out of the headline total and out of the daily series', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Db } = await import('../src/core/db.js');
    const { computeCostSummary } = await import('../src/core/cost.js');

    const dir = mkdtempSync(join(tmpdir(), 'sync-hub-bound-'));
    const db = new Db(join(dir, 'hub.sqlite'));
    const now = '2024-08-01T10:00:00.000Z';
    db.upsertProject({ id: 'p1', name: 'P', canonicalPath: '/tmp/p', aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: now, lastActiveAt: now });
    db.upsertThread({ id: 'chatgpt-export-abc', projectId: 'p1', title: 'T', originEngine: 'codex', engineIds: {}, messageCount: 0, createdAt: now, updatedAt: now, status: 'active' });
    db.insertMessage({
      id: 'a1', threadId: 'chatgpt-export-abc', projectId: 'p1', sourceEngine: 'codex', role: 'assistant',
      content: 'une réponse archivée', timestamp: now, sequence: 0, hash: 'h1', estimatedTokens: 1_000_000,
    });

    try {
      const s = computeCostSummary(db, {});
      // 1M output tokens on gpt-4o (the flagship on 2024-08-01) = $10.
      expect(s.upperBoundCostUsd).toBeCloseTo(10, 2);
      expect(s.upperBoundMessageCount).toBe(1);
      // The whole point: a guessed rate must not reach anything a reader takes for spend.
      expect(s.totalCostUsd).toBe(0);
      expect(s.measuredCostUsd).toBe(0);
      expect(s.byDate).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
