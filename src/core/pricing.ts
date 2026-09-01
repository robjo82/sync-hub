import type { TokenUsage } from '../types.js';

/**
 * Per-model API pricing, in USD per million tokens. Sourced directly from
 * https://platform.claude.com/docs/en/about-claude/pricing and https://developers.openai.com/api/docs/pricing
 * (fetched 2026-08-20) — never guessed. Robin runs these tools through subscriptions (Claude /
 * ChatGPT), not raw API billing, so a cost computed here is deliberately a "what this would have
 * cost via the API" estimate, not a reconciliation of an actual bill — see estimateCostUsd.
 *
 * Model ids are keyed exactly as they appear in real session files (verified against Robin's own
 * ~/.claude/projects and ~/.codex/sessions — hyphenated version numbers, no dots, sometimes a
 * trailing date), which differ from the pricing pages' display names.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Claude: cost per MTok newly written to a 5-minute-TTL cache entry. */
  cacheWrite5mPerMTok?: number;
  /** Claude: cost per MTok newly written to a 1-hour-TTL cache entry. */
  cacheWrite1hPerMTok?: number;
  /** Claude: cost per MTok read from an existing cache entry. */
  cacheReadPerMTok?: number;
  /** OpenAI/Codex: cost per MTok of cached input (single combined rate, no write/read split). */
  cachedInputPerMTok?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude (platform.claude.com/docs/en/about-claude/pricing)
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30, cacheReadPerMTok: 1.5 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30, cacheReadPerMTok: 1.5 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.2 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 },
  'claude-haiku-3-5': { inputPerMTok: 0.8, outputPerMTok: 4, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1.6, cacheReadPerMTok: 0.08 },

  // OpenAI / Codex (developers.openai.com/api/docs/pricing) — gpt-5.3-codex intentionally
  // omitted: confirmed (learn.chatgpt.com/docs/pricing) to be research-preview only, "isn't
  // available in the API at launch", no published per-token rate to use.
  'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5 },
  'gpt-5.6-terra': { inputPerMTok: 2, outputPerMTok: 12, cachedInputPerMTok: 0.2 },
  'gpt-5.6-luna': { inputPerMTok: 0.2, outputPerMTok: 1.2, cachedInputPerMTok: 0.02 },
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cachedInputPerMTok: 0.5 },
  'gpt-5.5-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25 },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cachedInputPerMTok: 0.075 },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25, cachedInputPerMTok: 0.02 },
  'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.2': { inputPerMTok: 1.75, outputPerMTok: 14, cachedInputPerMTok: 0.175 },
  'gpt-5.2-pro': { inputPerMTok: 21, outputPerMTok: 168 },
  'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4, cachedInputPerMTok: 0.005 },
  'gpt-5-pro': { inputPerMTok: 15, outputPerMTok: 120 },
  // Earlier generations, kept because the Claude.ai / ChatGPT archives reach back to Dec 2022 and
  // a 2023 conversation cannot be priced with a 2026 rate. These are the published list prices of
  // the time; where a model was repriced during its life (gpt-4o launched at 5/15 before settling
  // at 2.50/10) the later, longer-lived rate is used.
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
  'gpt-4-turbo': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-3.5-turbo': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'claude-3-opus': { inputPerMTok: 15, outputPerMTok: 75, cacheWrite5mPerMTok: 18.75, cacheReadPerMTok: 1.5 },
  'claude-3-5-sonnet': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheReadPerMTok: 0.3 },
  'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheWrite5mPerMTok: 0.3, cacheReadPerMTok: 0.03 },

  // Google Gemini / Antigravity (ai.google.dev/pricing)
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 5.0, cachedInputPerMTok: 0.3125 },
  'gemini-2.5-flash': { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.01875 },
  'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.025 },
  'gemini-1.5-pro': { inputPerMTok: 1.25, outputPerMTok: 5.0, cachedInputPerMTok: 0.3125 },
  'gemini-1.5-flash': { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.01875 },
};

export const DEFAULT_EUR_USD_RATE = 0.92;

/** Converts an amount in USD to EUR using the provided exchange rate (defaults to 0.92 EUR / USD). */
export function usdToEur(usd: number, rate = DEFAULT_EUR_USD_RATE): number {
  return usd * rate;
}

export const ENGINE_PROVIDER_MAP: Record<string, { provider: string; label: string; color: string }> = {
  'claude-code': { provider: 'Anthropic', label: 'Claude Code', color: '#d97706' },
  codex: { provider: 'OpenAI', label: 'Codex / ChatGPT', color: '#10b981' },
  antigravity: { provider: 'Google', label: 'Google Antigravity', color: '#3b82f6' },
};

export function getProviderForModel(model: string | undefined, sourceEngine?: string): string {
  if (!model) {
    if (sourceEngine === 'claude-code') return 'Anthropic';
    if (sourceEngine === 'codex') return 'OpenAI';
    if (sourceEngine === 'antigravity') return 'Google';
    return 'Inconnu';
  }
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'Anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'OpenAI';
  if (m.startsWith('gemini')) return 'Google';
  if (sourceEngine === 'antigravity') return 'Google';
  if (sourceEngine === 'claude-code') return 'Anthropic';
  if (sourceEngine === 'codex') return 'OpenAI';
  return 'Autre';
}

/** Real ids sometimes carry a trailing snapshot date (e.g. "claude-haiku-4-5-20251001") not present in the pricing table's keys. */
function resolvePricing(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(/-\d{8}$/, '')];
}

/**
 * Estimated USD cost of one turn's real token usage, at the given model's published API rate.
 * Returns null (never 0) when the model or its usage is unknown/unpriced — a missing price must
 * never be silently treated as free. Deliberately an *estimate of API-equivalent cost*, not a
 * reconciliation of what Robin was actually billed (he runs these tools via subscriptions).
 */
export function estimateCostUsd(model: string | undefined, usage: TokenUsage | undefined): number | null {
  if (!model || !usage) return null;
  const pricing = resolvePricing(model);
  if (!pricing) return null;
  return costFromPricing(pricing, usage);
}

/** The cost formula itself, shared so an interpolated rate is applied exactly like a published one. */
export function costFromPricing(pricing: ModelPricing, usage: TokenUsage): number {
  let cost = (usage.inputTokens * pricing.inputPerMTok) / 1_000_000 + (usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
  if (usage.cacheCreation5mInputTokens && pricing.cacheWrite5mPerMTok) {
    cost += (usage.cacheCreation5mInputTokens * pricing.cacheWrite5mPerMTok) / 1_000_000;
  }
  if (usage.cacheCreation1hInputTokens && pricing.cacheWrite1hPerMTok) {
    cost += (usage.cacheCreation1hInputTokens * pricing.cacheWrite1hPerMTok) / 1_000_000;
  }
  if (usage.cacheReadInputTokens && pricing.cacheReadPerMTok) {
    cost += (usage.cacheReadInputTokens * pricing.cacheReadPerMTok) / 1_000_000;
  }
  if (usage.cachedInputTokens && pricing.cachedInputPerMTok) {
    cost += (usage.cachedInputTokens * pricing.cachedInputPerMTok) / 1_000_000;
  }
  return cost;
}

/**
 * A rate for a model with no published price, derived from its immediate neighbours in the same
 * family — gpt-5.3-codex sits between gpt-5.2 (1.75/14) and gpt-5.4 (2.50/15).
 *
 * Interpolation only, never extrapolation. There is no usable global trend to extend: across this
 * very table OpenAI's flagship input rate rose 4× over the 5.x line while Claude Opus fell 3×, so
 * projecting one shape onto everything would be wrong in both directions. Between two known
 * adjacent versions of one family, the guess is bounded by real numbers on either side.
 *
 * Returns null when the model is outside the known range, which keeps it honestly uncounted
 * rather than confidently wrong.
 */
export function interpolatePricing(model: string | undefined): ModelPricing | null {
  if (!model) return null;
  const target = parseFamilyVersion(model);
  if (!target) return null;

  let below: { version: number; pricing: ModelPricing } | null = null;
  let above: { version: number; pricing: ModelPricing } | null = null;

  for (const [name, pricing] of Object.entries(MODEL_PRICING)) {
    const candidate = parseFamilyVersion(name);
    if (!candidate || candidate.family !== target.family) continue;
    if (candidate.version <= target.version && (!below || candidate.version > below.version)) below = { version: candidate.version, pricing };
    if (candidate.version >= target.version && (!above || candidate.version < above.version)) above = { version: candidate.version, pricing };
  }

  if (!below || !above) return null;
  if (below.version === above.version) return below.pricing;

  const ratio = (target.version - below.version) / (above.version - below.version);
  const mix = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? undefined : a + (b - a) * ratio;

  return {
    inputPerMTok: mix(below.pricing.inputPerMTok, above.pricing.inputPerMTok)!,
    outputPerMTok: mix(below.pricing.outputPerMTok, above.pricing.outputPerMTok)!,
    cachedInputPerMTok: mix(below.pricing.cachedInputPerMTok, above.pricing.cachedInputPerMTok),
    cacheWrite5mPerMTok: mix(below.pricing.cacheWrite5mPerMTok, above.pricing.cacheWrite5mPerMTok),
    cacheWrite1hPerMTok: mix(below.pricing.cacheWrite1hPerMTok, above.pricing.cacheWrite1hPerMTok),
    cacheReadPerMTok: mix(below.pricing.cacheReadPerMTok, above.pricing.cacheReadPerMTok),
  };
}

/**
 * Splits `gpt-5.3-codex` into family `gpt` and version 5.3, so neighbours can be compared.
 * A trailing qualifier (-codex, -pro, -mini) is deliberately dropped: it names a variant, and
 * mixing tiers would interpolate a nano rate towards a pro one.
 */
function parseFamilyVersion(model: string): { family: string; version: number } | null {
  const match = /^([a-z]+(?:-[a-z]+)*?)-(\d+)(?:[.-](\d+))?/.exec(model.toLowerCase());
  if (!match) return null;
  const [, family, major, minor] = match;
  // Only plain versioned models take part: a qualifier means a different price tier entirely.
  const rest = model.toLowerCase().slice(match[0].length);
  if (rest && !/^-codex$/.test(rest)) return null;
  return { family, version: Number(major) + (minor ? Number(minor) / 100 : 0) };
}

/** Whether a model has a published price at all — lets callers distinguish "$0" from "unknown". */
export function hasPricing(model: string | undefined): boolean {
  return !!model && !!resolvePricing(model);
}
