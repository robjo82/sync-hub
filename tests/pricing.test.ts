import { describe, expect, it } from 'vitest';
import { estimateCostUsd, hasPricing } from '../src/core/pricing.js';

describe('estimateCostUsd', () => {
  it('computes a real Claude turn (base input + output + 1h cache write + cache read)', () => {
    // Real shape from Robin's own Claude Code sessions (claude-fable-5: $10/$50/MTok, $20/MTok 1h write, $1/MTok read).
    const cost = estimateCostUsd('claude-fable-5', {
      inputTokens: 14986,
      outputTokens: 358,
      cacheCreation1hInputTokens: 4479,
      cacheReadInputTokens: 20090,
    });
    const expected = (14986 * 10 + 358 * 50 + 4479 * 20 + 20090 * 1) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('computes a real Codex turn (base input + output + single cached-input rate)', () => {
    // Real shape from Robin's own Codex sessions (gpt-5.5: $5/$30/MTok, $0.50/MTok cached).
    const cost = estimateCostUsd('gpt-5.5', { inputTokens: 18355, outputTokens: 41, cachedInputTokens: 16768 });
    const expected = (18355 * 5 + 41 * 30 + 16768 * 0.5) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('resolves a model id with a trailing snapshot date to its base pricing entry', () => {
    const dated = estimateCostUsd('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 });
    const bare = estimateCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(dated).toBe(bare);
    expect(dated).toBe(1); // $1/MTok input
  });

  it('returns null (never 0) for a model with no published price — e.g. gpt-5.3-codex, confirmed research-preview only, not silently free', () => {
    expect(estimateCostUsd('gpt-5.3-codex', { inputTokens: 1000, outputTokens: 100 })).toBeNull();
    expect(hasPricing('gpt-5.3-codex')).toBe(false);
  });

  it('returns null when the model or usage is missing', () => {
    expect(estimateCostUsd(undefined, { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(estimateCostUsd('claude-sonnet-5', undefined)).toBeNull();
  });

  it('reasoning_output_tokens is informational only — never added on top of outputTokens (it is already a subset, per OpenAI\'s own total_tokens accounting)', () => {
    const withReasoning = estimateCostUsd('gpt-5.5', { inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20 });
    const withoutReasoning = estimateCostUsd('gpt-5.5', { inputTokens: 100, outputTokens: 50 });
    expect(withReasoning).toBe(withoutReasoning);
  });
});
