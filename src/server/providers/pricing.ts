/**
 * OWNER: A7. Pricing ASSUMPTIONS used only for ESTIMATED cost (always labelled as an estimate).
 *
 * DEFAULT_PRICING holds Anthropic list prices per million tokens (MTok) as recorded from the
 * Claude API reference bundled with Claude Code (models.md / model-migration.md), asOf 2026-06-24.
 * They are defaults the user can override in Settings; they are not fetched from Anthropic and
 * may be out of date. Models whose price was not stated in that reference are deliberately
 * absent (cost then shows as unknown until the user enters pricing).
 *
 * Cache-rate assumption: cache read = 0.1 × input and 5-minute cache write = 1.25 × input,
 * EXCEPT where the reference states a different figure explicitly (noted per entry).
 *
 * No OpenAI-compatible defaults: endpoints and prices vary, so the user enters them.
 *
 * Token accounting convention used by the adapters (see docs/providers.md):
 *   inputTokens      = uncached input tokens
 *   cacheReadTokens  = input tokens served from cache (billed at the cache-read rate)
 *   cacheWriteTokens = input tokens written to cache (billed at the cache-write rate)
 *   outputTokens     = all output tokens incl. reasoning (reasoningTokens is a subset, not added)
 */
import type { AiProviderKind, Pricing, UsageNumbers, UsdMicros } from '../../shared/contracts.js';

export const PRICING_AS_OF = '2026-06-24';

function claude(
  input: number,
  output: number,
  explicit: { cacheRead?: number; cacheWrite?: number } = {},
): Pricing {
  return {
    inputPerMTokUsd: input,
    outputPerMTokUsd: output,
    cacheReadPerMTokUsd: explicit.cacheRead ?? round6(input * 0.1),
    cacheWritePerMTokUsd: explicit.cacheWrite ?? round6(input * 1.25),
    source: 'default-assumption',
    asOf: PRICING_AS_OF,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Keyed `${kind}:${model}` (same key format as AppSettings.pricing). */
export const DEFAULT_PRICING: Record<string, Pricing> = Object.freeze({
  // $10 / $50; reference states cache reads $0.25/MTok (0.025×) and 5-minute cache writes $12.50.
  'anthropic:claude-fable-5-1': claude(10, 50, { cacheRead: 0.25, cacheWrite: 12.5 }),
  // Same per-token price as Fable 5.1; the reference leaves its cache-read rate open, so the
  // conservative 0.1× assumption ($1.00) is used.
  'anthropic:claude-mythos-5-1': claude(10, 50),
  // $10 / $50; reference states cache reads $1/MTok.
  'anthropic:claude-fable-5': claude(10, 50, { cacheRead: 1 }),
  'anthropic:claude-mythos-5': claude(10, 50, { cacheRead: 1 }),
  // $4 / $20; reference states cache reads $0.20/MTok and 5-minute cache writes $5.
  'anthropic:claude-opus-5-5': claude(4, 20, { cacheRead: 0.2, cacheWrite: 5 }),
  // $5 / $25.
  'anthropic:claude-opus-5': claude(5, 25),
  // $5 / $25 ("Opus 4.8's pricing").
  'anthropic:claude-opus-4-8': claude(5, 25),
  // $2 / $10.
  'anthropic:claude-sonnet-5': claude(2, 10),
  // $3 / $15.
  'anthropic:claude-sonnet-4-6': claude(3, 15),
}) as Record<string, Pricing>;

export function pricingKey(kind: AiProviderKind, model: string): string {
  return `${kind}:${model}`;
}

/** User pricing wins over the default assumption. */
export function resolvePricing(
  kind: AiProviderKind,
  model: string | null | undefined,
  userPricing?: Record<string, Pricing>,
  explicit?: Pricing,
): Pricing | undefined {
  if (explicit) return explicit;
  if (!model) return undefined;
  const key = pricingKey(kind, model);
  return userPricing?.[key] ?? DEFAULT_PRICING[key];
}

/** Integer micro-USD, rounded UP; tiny float noise (e.g. 7.0000000001) does not add a micro-dollar. */
function ceilMicros(x: number): number {
  return Math.max(0, Math.ceil(x - 1e-7));
}

function validCount(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Estimated cost of one attempt in micro-USD (rounded up), or null when usage is unknown or no
 * pricing is available. A price of $X per MTok is exactly X micro-USD per token.
 * Missing cache rates fall back conservatively: read → input rate, write → 1.25 × input rate.
 */
export function estimateCostMicros(usage: UsageNumbers, pricing: Pricing | undefined): UsdMicros | null {
  if (!pricing || !usage.known) return null;
  // An attempt with input or output unreported cannot be estimated honestly.
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return null;

  const cacheRead = validCount(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  const cacheWrite = validCount(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
  const readRate = pricing.cacheReadPerMTokUsd ?? pricing.inputPerMTokUsd;
  const writeRate = pricing.cacheWritePerMTokUsd ?? pricing.inputPerMTokUsd * 1.25;

  const micros =
    usage.inputTokens * pricing.inputPerMTokUsd +
    usage.outputTokens * pricing.outputPerMTokUsd +
    cacheRead * readRate +
    cacheWrite * writeRate;
  return Number.isFinite(micros) ? ceilMicros(micros) : null;
}

/**
 * Upper bound for a request that has not been sent yet (pre-request budget check):
 * every input token at the most expensive input rate (plain or cache write) and the full
 * max-output-token allowance. null when no pricing or the inputs are not valid counts.
 */
export function worstCaseCostMicros(
  inputTokensEstimate: number,
  maxOutputTokens: number,
  pricing: Pricing | undefined,
): UsdMicros | null {
  if (!pricing) return null;
  if (!Number.isFinite(inputTokensEstimate) || inputTokensEstimate < 0) return null;
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 0) return null;
  const inputRate = Math.max(pricing.inputPerMTokUsd, pricing.cacheWritePerMTokUsd ?? 0);
  const micros = Math.ceil(inputTokensEstimate) * inputRate + Math.ceil(maxOutputTokens) * pricing.outputPerMTokUsd;
  return Number.isFinite(micros) ? ceilMicros(micros) : null;
}
