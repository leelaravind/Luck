import { describe, expect, it } from 'vitest';
import type { Pricing, UsageNumbers } from '../../shared/contracts.js';
import { DEFAULT_PRICING, PRICING_AS_OF, estimateCostMicros, resolvePricing, worstCaseCostMicros } from './pricing.js';

const usage = (over: Partial<UsageNumbers> = {}): UsageNumbers => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: true,
  ...over,
});

const user: Pricing = { inputPerMTokUsd: 1, outputPerMTokUsd: 2, source: 'user' };

describe('DEFAULT_PRICING (documented default assumptions)', () => {
  it('only has anthropic:* keys, all labelled default-assumption with asOf', () => {
    const keys = Object.keys(DEFAULT_PRICING);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith('anthropic:')).toBe(true);
      expect(DEFAULT_PRICING[k]).toMatchObject({ source: 'default-assumption', asOf: PRICING_AS_OF });
    }
    expect(PRICING_AS_OF).toBe('2026-06-24');
    expect(keys.some((k) => k.startsWith('openai:'))).toBe(false);
  });

  it('applies 0.1× read / 1.25× write unless the reference states otherwise', () => {
    expect(DEFAULT_PRICING['anthropic:claude-opus-5']).toMatchObject({
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 6.25,
    });
    expect(DEFAULT_PRICING['anthropic:claude-fable-5-1']).toMatchObject({ cacheReadPerMTokUsd: 0.25, cacheWritePerMTokUsd: 12.5 });
  });

  it('resolvePricing prefers explicit, then user, then default', () => {
    expect(resolvePricing('anthropic', 'claude-opus-5')).toBe(DEFAULT_PRICING['anthropic:claude-opus-5']);
    expect(resolvePricing('anthropic', 'claude-opus-5', { 'anthropic:claude-opus-5': user })).toBe(user);
    expect(resolvePricing('openai', 'gpt-x')).toBeUndefined();
    expect(resolvePricing('anthropic', undefined)).toBeUndefined();
  });
});

describe('estimateCostMicros', () => {
  const opus = DEFAULT_PRICING['anthropic:claude-opus-5'];

  it('$X per MTok is X micro-USD per token (exact integer case)', () => {
    // 1000 × 5 + 200 × 25 = 10_000 micro-USD = $0.01
    expect(estimateCostMicros(usage({ inputTokens: 1000, outputTokens: 200 }), opus)).toBe(10_000);
  });

  it('adds cache read and write at their rates; reasoning is not double counted', () => {
    // 1000×5 + 200×25 + 2000×0.5 + 100×6.25 = 5000 + 5000 + 1000 + 625
    expect(
      estimateCostMicros(usage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 2000, cacheWriteTokens: 100, reasoningTokens: 150 }), opus),
    ).toBe(11_625);
  });

  it('rounds up fractional micro-dollars', () => {
    // 3 cache-read tokens × $0.25/MTok = 0.75 micro-USD → 1
    expect(estimateCostMicros(usage({ cacheReadTokens: 3 }), DEFAULT_PRICING['anthropic:claude-fable-5-1'])).toBe(1);
    expect(estimateCostMicros(usage({ inputTokens: 1 }), { inputPerMTokUsd: 0.3, outputPerMTokUsd: 1, source: 'user' })).toBe(1);
  });

  it('falls back conservatively when cache rates are missing', () => {
    expect(estimateCostMicros(usage({ cacheReadTokens: 10, cacheWriteTokens: 10 }), user)).toBe(10 + Math.ceil(12.5));
  });

  it('returns null when usage is unknown, partially unreported, or pricing is missing', () => {
    expect(estimateCostMicros(usage({ known: false, inputTokens: 10, outputTokens: 1 }), opus)).toBeNull();
    expect(estimateCostMicros(usage({ inputTokens: 10, outputTokens: null }), opus)).toBeNull();
    expect(estimateCostMicros(usage({ inputTokens: 10, outputTokens: 1 }), undefined)).toBeNull();
  });
});

describe('worstCaseCostMicros', () => {
  it('prices all input at the most expensive input rate plus the full output allowance', () => {
    // opus-5: max(5, 6.25) × 1000 + 25 × 400 = 6250 + 10000
    expect(worstCaseCostMicros(1000, 400, DEFAULT_PRICING['anthropic:claude-opus-5'])).toBe(16_250);
    expect(worstCaseCostMicros(1000, 400, user)).toBe(1000 + 800);
  });

  it('is never below the estimate for the same token counts', () => {
    const p = DEFAULT_PRICING['anthropic:claude-sonnet-5'];
    const est = estimateCostMicros(usage({ inputTokens: 900, outputTokens: 350, cacheReadTokens: 100 }), p)!;
    expect(worstCaseCostMicros(1000, 350, p)!).toBeGreaterThanOrEqual(est);
  });

  it('returns null without pricing or with invalid inputs', () => {
    expect(worstCaseCostMicros(1000, 400, undefined)).toBeNull();
    expect(worstCaseCostMicros(-1, 400, user)).toBeNull();
    expect(worstCaseCostMicros(Number.NaN, 400, user)).toBeNull();
  });
});
