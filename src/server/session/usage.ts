/**
 * Usage accounting: one UsageRecord per provider attempt (including failed, retried, cancelled
 * and stale attempts) and the per-session UsageSummary.
 *
 * Honesty rules:
 *  - token counts are copied from the provider; unknown values stay null (never estimated)
 *  - cost is provider-reported (Claude Code CLI), estimated from a labelled pricing assumption
 *    (cloud APIs), zero for local inference, or null/'unknown' — never invented
 *  - throughput is only computed when both output tokens and a duration are known
 */
import { randomUUID } from 'node:crypto';
import {
  MICROS_PER_USD,
  type CostBasis,
  type PlayerKind,
  type Pricing,
  type ProviderCapabilities,
  type UsageAttemptStatus,
  type UsageNumbers,
  type UsageRecord,
  type UsageSummary,
  type UsdMicros,
} from '../../shared/contracts.js';
import type { ProviderCallResult } from '../types.js';
import { estimateCostMicros } from '../providers/pricing.js';

export const UNKNOWN_USAGE: UsageNumbers = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
});

/** outputTokens / seconds of (generation time, else end-to-end latency); null when either is unknown. */
export function outputTokensPerSec(outputTokens: number | null, generationMs: number | null, latencyMs: number | null): number | null {
  if (outputTokens === null || !Number.isFinite(outputTokens) || outputTokens <= 0) return null;
  const ms = generationMs ?? latencyMs;
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((outputTokens / (ms / 1000)) * 10) / 10;
}

/**
 * Cost of one attempt and how it was determined.
 *  - not paid (local)                          → 0, 'local-no-charge'
 *  - provider reported a cost (CLI)            → that figure, 'provider-reported'
 *  - usage known + pricing assumption          → estimate, 'estimated-from-pricing'
 *  - otherwise                                 → null, 'unknown'
 */
export function attemptCost(input: {
  capabilities: Pick<ProviderCapabilities, 'paid' | 'reportsCost'>;
  usage: UsageNumbers;
  providerCostUsd: number | null;
  pricing: Pricing | null;
}): { costMicros: UsdMicros | null; costBasis: CostBasis } {
  if (!input.capabilities.paid) return { costMicros: 0, costBasis: 'local-no-charge' };
  if (typeof input.providerCostUsd === 'number' && Number.isFinite(input.providerCostUsd) && input.providerCostUsd >= 0) {
    return { costMicros: Math.round(input.providerCostUsd * MICROS_PER_USD), costBasis: 'provider-reported' };
  }
  if (input.usage.known && input.pricing) {
    const est = estimateCostMicros(input.usage, input.pricing);
    if (typeof est === 'number' && Number.isFinite(est)) return { costMicros: Math.round(est), costBasis: 'estimated-from-pricing' };
  }
  return { costMicros: null, costBasis: 'unknown' };
}

/** Attempt status for a provider result. */
export function usageStatusFor(result: Pick<ProviderCallResult, 'ok' | 'error'>): UsageAttemptStatus {
  if (result.ok) return 'ok';
  switch (result.error?.code) {
    case 'timeout':
      return 'timeout';
    case 'rate_limited':
      return 'rate_limited';
    case 'cancelled':
      return 'cancelled';
    case 'invalid_output':
      return 'invalid_output';
    default:
      return 'error';
  }
}

export function buildUsageRecord(input: {
  sessionId: string;
  decisionId: string;
  attempt: number;
  providerKind: PlayerKind;
  model: string | null;
  status: UsageAttemptStatus;
  result: ProviderCallResult | null;
  capabilities: Pick<ProviderCapabilities, 'paid' | 'reportsCost'>;
  pricing: Pricing | null;
  createdAt: string;
}): UsageRecord {
  const r = input.result;
  const usage: UsageNumbers = r?.usage ? normaliseUsage(r.usage) : { ...UNKNOWN_USAGE };
  const latencyMs = r && Number.isFinite(r.latencyMs) ? Math.max(0, Math.round(r.latencyMs)) : null;
  const generationMs = r?.generationMs != null && Number.isFinite(r.generationMs) ? Math.max(0, Math.round(r.generationMs)) : null;
  const cost = attemptCost({
    capabilities: input.capabilities,
    usage,
    providerCostUsd: r?.providerCostUsd ?? null,
    pricing: input.pricing,
  });
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    decisionId: input.decisionId,
    attempt: input.attempt,
    providerKind: input.providerKind,
    model: r?.modelReported ?? input.model,
    status: input.status,
    ...usage,
    latencyMs,
    generationMs,
    outputTokensPerSec: outputTokensPerSec(usage.outputTokens, generationMs, latencyMs),
    costMicros: cost.costMicros,
    costBasis: cost.costBasis,
    rateLimit: r?.rateLimit ?? null,
    createdAt: input.createdAt,
  };
}

/** Keep only non-negative integer counts; anything else becomes null (unknown). */
function normaliseUsage(u: UsageNumbers): UsageNumbers {
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    cacheWriteTokens: n(u.cacheWriteTokens),
    reasoningTokens: n(u.reasoningTokens),
    known: u.known === true,
  };
}

/**
 * Session summary. `budgetMicros` is only reported for paid providers (it is an app-side
 * spending limit, not a provider quota); `defaultBasis` is used when there are no records.
 */
export function summarizeUsage(
  records: readonly UsageRecord[],
  opts: { budgetMicros: UsdMicros | null; paid: boolean; defaultBasis: CostBasis },
): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let costMicros = 0;
  let failed = 0;
  let unknownUsage = 0;
  let costIsPartial = false;
  let latencySum = 0;
  let latencyCount = 0;
  let lastLatencyMs: number | null = null;
  let lastTps: number | null = null;
  let lastRateLimit: UsageSummary['lastRateLimit'] = null;
  const basisCounts = new Map<CostBasis, number>();

  for (const r of records) {
    if (r.status !== 'ok') failed++;
    if (!r.known) unknownUsage++;
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
    cacheReadTokens += r.cacheReadTokens ?? 0;
    cacheWriteTokens += r.cacheWriteTokens ?? 0;
    reasoningTokens += r.reasoningTokens ?? 0;
    if (r.costMicros !== null) {
      costMicros += r.costMicros;
      basisCounts.set(r.costBasis, (basisCounts.get(r.costBasis) ?? 0) + 1);
    } else if (opts.paid || r.costBasis === 'unknown') {
      costIsPartial = true;
    }
    if (r.latencyMs !== null) {
      latencySum += r.latencyMs;
      latencyCount++;
      lastLatencyMs = r.latencyMs;
    }
    if (r.outputTokensPerSec !== null) lastTps = r.outputTokensPerSec;
    if (r.rateLimit) lastRateLimit = r.rateLimit;
  }

  let costBasis: CostBasis = records.length === 0 ? opts.defaultBasis : 'unknown';
  let best = 0;
  for (const [basis, count] of basisCounts) {
    if (count > best) {
      best = count;
      costBasis = basis;
    }
  }

  const budgetMicros = opts.paid ? opts.budgetMicros : null;
  return {
    requests: records.length,
    failedRequests: failed,
    unknownUsageRequests: unknownUsage,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    costMicros,
    costIsPartial,
    costBasis,
    lastLatencyMs,
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
    lastOutputTokensPerSec: lastTps,
    budgetMicros,
    budgetRemainingMicros: budgetMicros === null ? null : Math.max(0, budgetMicros - costMicros),
    lastRateLimit,
  };
}
