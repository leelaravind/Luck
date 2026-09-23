/**
 * Conservative, pre-request budget enforcement for PAID providers.
 *
 * Before EVERY attempt the runner asks: could this call push spending past the app budget?
 *   worst case = worstCaseCostMicros(ceil(promptChars / 3), maxOutputTokens, pricing)
 *   (Claude Code CLI without a pricing assumption: max(2 × last CLI-reported cost, 50_000 µ$))
 *   spent      = sum of known attempt costs
 *              + worst case for every earlier paid attempt whose cost is unknown but that may
 *                have been processed (ok / invalid_output / timeout / cancelled / stale / error —
 *                a connection reset or 5xx can happen after the provider did the work)
 *   blocked    ⇔ spent + worst case > budgetMicros
 * The budget is an app-side spending limit, not a provider quota.
 */
import type { Pricing, ProviderCapabilities, UsageAttemptStatus, UsageRecord, UsdMicros } from '../../shared/contracts.js';
import { formatUsdMicros } from '../../shared/money.js';
import { worstCaseCostMicros } from '../providers/pricing.js';

/** Floor for a CLI call's worst case when no pricing assumption and no history exist ($0.05). */
export const CLI_MIN_WORST_CASE_MICROS = 50_000;
/** Conservative characters-per-token ratio for the input estimate (real text is usually ~4). */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

/** Attempts that may have been billed even though no cost was reported. */
// Only 'rate_limited' is excluded: a 429 is rejected before any work is done. 'error' is included on
// purpose (reviewer D1): errors after the request was sent may still have been processed and billed.
const MAYBE_BILLED: ReadonlySet<UsageAttemptStatus> = new Set(['ok', 'invalid_output', 'timeout', 'cancelled', 'stale', 'error']);

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN_ESTIMATE);
}

/** Worst-case cost of ONE attempt, or null when it cannot be bounded (no pricing, provider reports no cost). */
export function worstCaseAttemptMicros(input: {
  capabilities: Pick<ProviderCapabilities, 'kind' | 'reportsCost'>;
  pricing: Pricing | null;
  promptChars: number;
  maxOutputTokens: number;
  records: readonly UsageRecord[];
}): UsdMicros | null {
  let lastCliCost: number | null = null;
  for (const r of input.records) {
    if (r.costBasis === 'provider-reported' && r.costMicros !== null) lastCliCost = r.costMicros;
  }
  if (input.pricing) {
    const w = worstCaseCostMicros(estimateInputTokens(input.promptChars), input.maxOutputTokens, input.pricing);
    // null = the pricing entry could not bound this request; fall through (never treat it as $0).
    if (typeof w === 'number' && Number.isFinite(w)) {
      // The CLI resumes one conversation per session, re-sending earlier turns: the current prompt alone
      // under-estimates the input, so never go below 2 × the last CLI-reported cost (reviewer A11b-N5).
      if (input.capabilities.kind === 'claude-cli' && lastCliCost !== null) return Math.ceil(Math.max(w, 2 * lastCliCost));
      return Math.ceil(w);
    }
  }
  if (input.capabilities.kind === 'claude-cli' && input.capabilities.reportsCost) {
    let last: number | null = null;
    for (const r of input.records) {
      if (r.costBasis === 'provider-reported' && r.costMicros !== null) last = r.costMicros;
    }
    return Math.max(2 * (last ?? 0), CLI_MIN_WORST_CASE_MICROS);
  }
  return null;
}

/**
 * Conservative spend so far (see file comment). `outstandingAttempts` are requests the runner
 * stopped waiting for whose result has not arrived yet; each counts as a worst case.
 */
export function conservativeSpentMicros(
  records: readonly UsageRecord[],
  worstCaseMicros: UsdMicros,
  outstandingAttempts = 0,
): UsdMicros {
  let spent = Math.max(0, outstandingAttempts) * worstCaseMicros;
  for (const r of records) {
    if (r.costMicros !== null) spent += r.costMicros;
    else if (r.costBasis === 'unknown' && MAYBE_BILLED.has(r.status)) spent += worstCaseMicros;
  }
  return spent;
}

export type BudgetCheck =
  /** remainingMicros null = no app spending limit (then worstCaseMicros may be null too). */
  | { allowed: true; worstCaseMicros: UsdMicros | null; spentMicros: UsdMicros; remainingMicros: UsdMicros | null; message?: string }
  | { allowed: false; worstCaseMicros: UsdMicros | null; spentMicros: UsdMicros; remainingMicros: UsdMicros | null; message: string };

export function checkBudget(input: {
  capabilities: Pick<ProviderCapabilities, 'kind' | 'reportsCost'>;
  pricing: Pricing | null;
  budgetMicros: UsdMicros | null;
  promptChars: number;
  maxOutputTokens: number;
  records: readonly UsageRecord[];
  outstandingAttempts?: number;
}): BudgetCheck {
  const outstanding = input.outstandingAttempts ?? 0;
  const worst = worstCaseAttemptMicros(input);
  if (input.budgetMicros === null) {
    // No app spending limit: the user chose to let the player run until the balance is exhausted.
    return {
      allowed: true,
      worstCaseMicros: worst,
      spentMicros: conservativeSpentMicros(input.records, worst ?? 0, outstanding),
      remainingMicros: null,
      message: 'No app spending limit is set for this session.',
    };
  }
  if (worst === null) {
    return {
      allowed: false,
      worstCaseMicros: null,
      spentMicros: conservativeSpentMicros(input.records, 0, outstanding),
      remainingMicros: null,
      message: 'The worst-case cost of a request cannot be bounded: add a pricing assumption for this model.',
    };
  }
  const spent = conservativeSpentMicros(input.records, worst, outstanding);
  const remaining = input.budgetMicros - spent;
  if (spent + worst > input.budgetMicros) {
    return {
      allowed: false,
      worstCaseMicros: worst,
      spentMicros: spent,
      remainingMicros: Math.max(0, remaining),
      message:
        `Budget exhausted: spent ${formatUsdMicros(spent)} (conservative) of the ${formatUsdMicros(input.budgetMicros)} app budget; ` +
        `the next request could cost up to ${formatUsdMicros(worst)} (worst case), so it was not sent.`,
    };
  }
  return { allowed: true, worstCaseMicros: worst, spentMicros: spent, remainingMicros: remaining };
}
