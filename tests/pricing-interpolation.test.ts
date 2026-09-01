import { describe, expect, it } from 'vitest';
import { interpolatePricing, hasPricing } from '../src/core/pricing.js';

describe('interpolatePricing', () => {
  it('prices gpt-5.3-codex from its immediate neighbours', () => {
    // gpt-5.2 = 1.75 / 14, gpt-5.4 = 2.50 / 15 → halfway.
    const p = interpolatePricing('gpt-5.3-codex');
    expect(p).not.toBeNull();
    expect(p!.inputPerMTok).toBeCloseTo(2.125, 3);
    expect(p!.outputPerMTok).toBeCloseTo(14.5, 3);
  });

  it('stays inside the bracket its neighbours define', () => {
    const p = interpolatePricing('gpt-5.3-codex')!;
    expect(p.inputPerMTok).toBeGreaterThan(1.75);
    expect(p.inputPerMTok).toBeLessThan(2.5);
  });

  it('refuses to extrapolate past the newest known version', () => {
    // No upper neighbour: the trend reverses between vendors, so there is nothing safe to extend.
    expect(interpolatePricing('gpt-9.9')).toBeNull();
  });

  it('does not mix price tiers — a nano rate must not drift towards a pro one', () => {
    expect(interpolatePricing('gpt-5.3-mini')).toBeNull();
    expect(interpolatePricing('gpt-5.3-pro')).toBeNull();
  });

  it('stays out of the way for models that already have a published price', () => {
    // Interpolation is for gaps; a real rate must always win.
    expect(hasPricing('gpt-5.5')).toBe(true);
    expect(hasPricing('gpt-5.3-codex')).toBe(false);
  });

  it('returns null rather than guessing for an unknown family', () => {
    expect(interpolatePricing('mistral-large-3')).toBeNull();
    expect(interpolatePricing(undefined)).toBeNull();
  });
});
