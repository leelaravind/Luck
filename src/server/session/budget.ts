/**
 * Conservative, pre-request budget enforcement for PAID providers.
 *
 * Before EVERY attempt the runner asks: could this call push spending past the app budget?
 *   worst case = worstCaseCostMicros(ceil(promptChars / 3), maxOutputTokens, pricing)
 *   (Claude Code CLI: max(that estimate if a pricing assumption exists, a cold re-write of the
 *    resumed conversation bounded from the last turn's cost and tokens, 50_000 µ$) — see cliWorstCase)
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

/** Floor for a Claude Code CLI call's worst case ($0.05), with or without a pricing assumption. */
export const CLI_MIN_WORST_CASE_MICROS = 50_000;
/** Conservative characters-per-token ratio for the input estimate (real text is usually ~4). */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/** Attempts that may have been billed even though no cost was reported. */
// Only 'rate_limited' is excluded: a 429 is rejected before any work is done. 'error' is included on
// purpose (reviewer D1): errors after the request was sent may still have been processed and billed.
const MAYBE_BILLED: ReadonlySet<UsageAttemptStatus> = new Set(['ok', 'invalid_output', 'timeout', 'cancelled', 'stale', 'error']);

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Price multipliers of Claude models relative to the base input price, used to bound a CLI turn from
 * the last turn's reported cost and tokens when no pricing assumption is needed.
 *  - LOW_*: the cheapest each token class can be (cache read 0.1×, cache write ≥ 1.25×, output ≥ 4× —
 *    Claude models charge 5×; 4 leaves margin). Dividing the last turn's cost by its tokens weighted
 *    with these gives a per-token price that can only be too HIGH, never too low.
 *  - Up to CLI_MAX_CALLS API calls per turn: when the output cap is hit the CLI continues up to 3 more
 *    times (observed, see docs/providers-cli-laya.md), each re-reading the context.
 *  - COLD_CONTEXT: a resumed turn whose prompt cache expired writes the whole context again at up to
 *    2× (1-hour cache write) and every further call reads it again at 0.1× (2 + 3 × 0.1, rounded up
 *    for the partial answers the continuations re-read).
 *  - OUTPUT_X_PRICE: every call answering with the full maxOutputTokens at 5×.
 */
const LOW_CACHE_READ = 0.1;
const LOW_CACHE_WRITE = 1.25;
const LOW_OUTPUT = 4;
const CLI_MAX_CALLS = 4;
const COLD_CONTEXT = 2.5;
const OUTPUT_X_PRICE = CLI_MAX_CALLS * 5;

/**
 * Bound of the next CLI turn from the last turn's tokens: every context token (the last turn's input,
 * cache reads, cache writes and output) plus the new prompt written cold, plus the output cap — at the
 * highest per-token price the last turn's cost allows. Null when the CLI reported no usable tokens.
 */
function cliTokenBound(last: UsageRecord, lastCost: number, promptChars: number, maxOutputTokens: number): number | null {
  if (!last.known || last.inputTokens === null || last.outputTokens === null) return null;
  const input = last.inputTokens;
  const read = last.cacheReadTokens ?? 0;
  const write = last.cacheWriteTokens ?? 0;
  const output = last.outputTokens;
  const weighted = input + LOW_CACHE_READ * read + LOW_CACHE_WRITE * write + LOW_OUTPUT * output;
  if (!(weighted > 0)) return null;
  const maxPerToken = lastCost / weighted;
  const context = input + read + write + output + estimateInputTokens(promptChars);
  return maxPerToken * (COLD_CONTEXT * context + OUTPUT_X_PRICE * Math.max(0, maxOutputTokens));
}

/**
 * Worst case of one Claude Code CLI turn. The CLI resumes ONE conversation per session and re-sends
 * every earlier turn, so the current prompt alone under-estimates the input (reviewer A11b-N5), and
 * the last turn's cost is no bound either: a warm turn is mostly cheap cache reads, but once the
 * prompt cache has expired (e.g. a session resumed after a long pause) the whole context is written
 * again at the cache-write price.
 *   - With the last turn's tokens: the cold re-write of that context at the highest price its cost
 *     allows (cliTokenBound). This grows with the conversation, not with what the session has spent,
 *     so a session with an app spending limit can use most of it.
 *   - Without them: the session's total CLI-reported cost so far (all turns together cost at least
 *     what writing the context once costs) or 2 × the last turn, whichever is larger. It is not used
 *     to cap the token bound: turns whose cost is unknown are missing from that total.
 * The result is at least the pricing estimate (when an assumption exists) and the 50 000 µ$ floor.
 */
function cliWorstCase(
  pricingEstimate: number | null,
  records: readonly UsageRecord[],
  promptChars: number,
  maxOutputTokens: number,
): UsdMicros {
  let last: UsageRecord | null = null;
  let lastCost = 0;
  let total = 0;
  for (const r of records) {
    if (r.costBasis === 'provider-reported' && r.costMicros !== null && Number.isFinite(r.costMicros)) {
      last = r;
      lastCost = r.costMicros;
      total += r.costMicros;
    }
  }
  const byTokens = last ? cliTokenBound(last, lastCost, promptChars, maxOutputTokens) : null;
  const conversation = byTokens ?? Math.max(2 * lastCost, total);
  return Math.ceil(Math.max(pricingEstimate ?? 0, conversation, CLI_MIN_WORST_CASE_MICROS));
}

/** Worst-case cost of ONE attempt, or null when it cannot be bounded (no pricing, provider reports no cost). */
function worstCaseAttemptMicros(input: {
  capabilities: Pick<ProviderCapabilities, 'kind' | 'reportsCost'>;
  pricing: Pricing | null;
  promptChars: number;
  maxOutputTokens: number;
  records: readonly UsageRecord[];
}): UsdMicros | null {
  let estimate: number | null = null;
  if (input.pricing) {
    const w = worstCaseCostMicros(estimateInputTokens(input.promptChars), input.maxOutputTokens, input.pricing);
    // null = the pricing entry could not bound this request (never treat it as $0).
    if (typeof w === 'number' && Number.isFinite(w)) estimate = w;
  }
  if (input.capabilities.kind === 'claude-cli' && (estimate !== null || input.capabilities.reportsCost)) {
    return cliWorstCase(estimate, input.records, input.promptChars, input.maxOutputTokens);
  }
  return estimate === null ? null : Math.ceil(estimate);
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
