/**
 * Conservative, pre-request budget enforcement for PAID providers.
 *
 * Before EVERY attempt the runner asks: could this call push spending past the app budget?
 *   worst case = worstCaseCostMicros(ceil(promptChars / 3), maxOutputTokens, pricing)
 *   (Claude Code CLI: max(that estimate if a pricing assumption exists, the cost of the resumed
 *    conversation's next turn with an expired prompt cache, 50_000 µ$) — see cliWorstCase)
 *   spent      = sum of known attempt costs
 *              + worst case for every earlier paid attempt whose cost is unknown but that may
 *                have been processed (ok / invalid_output / timeout / cancelled / stale / error —
 *                a connection reset or 5xx can happen after the provider did the work)
 *   blocked    ⇔ spent + worst case > budgetMicros
 * The budget is an app-side spending limit, not a provider quota.
 */
import type { Pricing, ProviderCapabilities, UsageAttemptStatus, UsageRecord, UsdMicros } from '../../shared/contracts.js';
import { formatUsdMicros } from '../../shared/money.js';
import { DEFAULT_PRICING, worstCaseCostMicros } from '../providers/pricing.js';

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
 * A Claude Code CLI turn can make up to CLI_MAX_CALLS API calls: when the output cap is hit the CLI
 * continues up to 3 more times (observed, see docs/providers-cli-laya.md), each call re-reading the
 * context and the answer so far.
 */
const CLI_MAX_CALLS = 4;
/** Context the CLI adds to the first turn besides Luck's prompt (environment, date, model, reminders). */
const CLI_ADDED_TOKENS = 1_000;

/**
 * Cache-read price as a fraction of base input for the Claude models whose rate the bundled Claude API
 * reference states (keyed by model id without "claude-", a date suffix or "[1m]"). Any other model —
 * including Claude Mythos 5.1, whose rate the reference leaves open — gets the lowest known ratio: a
 * lower ratio makes the price derived from a warm turn HIGHER, so the bound stays safe.
 */
const CACHE_READ_RATIO: Readonly<Record<string, number>> = {
  'fable-5-1': 0.025,
  'opus-5-5': 0.05,
  // "0.1x on other models"
  'fable-5': 0.1,
  'mythos-5': 0.1,
  'opus-5': 0.1,
  'opus-4-8': 0.1,
  'sonnet-5': 0.1,
  'sonnet-4-6': 0.1,
  'sonnet-4-5': 0.1,
  'haiku-4-5': 0.1,
};
const LOWEST_CACHE_READ_RATIO = Math.min(...Object.values(CACHE_READ_RATIO));
/** The highest base input price of a known Claude model (µ$ per token = $ per MTok), for unknown models. */
const HIGHEST_INPUT_PRICE = Math.max(
  ...Object.entries(DEFAULT_PRICING)
    .filter(([key]) => key.startsWith('anthropic:'))
    .map(([, p]) => p.inputPerMTokUsd),
);

/** "claude-haiku-4-5-20251001" / "claude-opus-5-5[1m]" → "haiku-4-5" / "opus-5-5"; null when unknown. */
export function normalizeClaudeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
  return m || null;
}

/**
 * Whether a turn reported with `reported` was made with the session's configured model: an alias
 * ("haiku", "opus") matches its family, a full id matches itself. No configured model = the CLI's
 * default, which cannot be compared (see the note in cliWorstCase).
 */
function sameModel(configured: string | null | undefined, reported: string | null): boolean {
  const c = normalizeClaudeModel(configured);
  if (c === null) return true;
  const r = normalizeClaudeModel(reported);
  if (r === null) return false;
  return /\d/.test(c) ? r === c : r === c || r.startsWith(`${c}-`);
}

/** Prices of the next turn in µ$ per token. */
interface TurnPrices {
  read: number;
  write: number;
  output: number;
}

/** Claude price structure on a base input price: read ≤ 0.1×, 1-hour cache write 2×, output 5×. */
function pricesFromBase(input: number): TurnPrices {
  return { read: 0.1 * input, write: 2 * input, output: 5 * input };
}

/** A pricing assumption, conservatively: a missing read rate = input, a write at least the 1-hour 2×. */
function pricesFromPricing(p: Pricing): TurnPrices {
  const input = p.inputPerMTokUsd;
  return {
    read: p.cacheReadPerMTokUsd ?? input,
    write: Math.max(p.cacheWritePerMTokUsd ?? 1.25 * input, 2 * input),
    output: p.outputPerMTokUsd,
  };
}

/** All four token counts of an attempt, or null when any is unreported. */
function tokensOf(r: UsageRecord): { input: number; read: number; write: number; output: number } | null {
  if (!r.known || r.inputTokens === null || r.outputTokens === null || r.cacheReadTokens === null || r.cacheWriteTokens === null) return null;
  return { input: r.inputTokens, read: r.cacheReadTokens, write: r.cacheWriteTokens, output: r.outputTokens };
}

/**
 * The highest base input price a turn's CLI-reported cost allows: its cost divided by its tokens,
 * each weighted with the CHEAPEST rate its class can have for that model (cache read at the model's
 * ratio, cache write 1.25×, output 4× although Claude charges 5×). Null without cost or tokens.
 */
function highestBasePrice(r: UsageRecord): number | null {
  const t = tokensOf(r);
  if (!t || r.costMicros === null || !(r.costMicros > 0)) return null;
  const ratio = CACHE_READ_RATIO[normalizeClaudeModel(r.model) ?? ''] ?? LOWEST_CACHE_READ_RATIO;
  const weighted = t.input + ratio * t.read + 1.25 * t.write + 4 * t.output;
  return weighted > 0 ? r.costMicros / weighted : null;
}

/**
 * A turn whose prompt cache has expired: the whole context written once, re-read by every further
 * call together with the answer so far, and every call answering with the full output cap.
 */
function coldTurnMicros(p: TurnPrices, contextTokens: number, maxOutputTokens: number): number {
  const out = Math.max(0, maxOutputTokens);
  const more = CLI_MAX_CALLS - 1;
  return p.write * contextTokens + more * p.read * (contextTokens + more * out) + CLI_MAX_CALLS * p.output * out;
}

/**
 * Worst case of one Claude Code CLI turn. The CLI resumes ONE conversation per session and re-sends
 * every earlier turn, so the current prompt alone under-estimates the input (reviewer A11b-N5), and
 * the last turn's cost is no bound either: a warm turn is mostly cheap cache reads, but once the
 * prompt cache has expired (e.g. a session resumed after a long pause) the whole context is written
 * again at the cache-write price — up to 80× a cache read on Claude Fable 5.1.
 *
 * Prices of the next turn: the pricing assumption when one exists; else the highest base price the
 * last priced turn's cost allows (highestBasePrice), when it was made with the configured model; else
 * the configured model's built-in price; else the highest known Claude price. The context is the
 * newest turn whose four token counts are all reported plus the new prompt (on the first turn: the
 * prompt plus what the CLI adds), priced as a cold turn (coldTurnMicros). When the CLI reported no
 * tokens for any turn, the older, approximate rule max(2 × the last turn, the total so far) is used.
 * The result is at least the pricing estimate and the 50 000 µ$ floor.
 *
 * Limit: with no model configured the CLI uses its own default model, which could change between two
 * turns (e.g. after a CLI update) to a dearer one; that turn can then cost more than this bound. The
 * CLI's own --max-budget-usd stop (the remaining budget) still ends it after the API call in progress.
 */
function cliWorstCase(input: {
  pricing: Pricing | null;
  pricingEstimate: number | null;
  model: string | null;
  records: readonly UsageRecord[];
  promptChars: number;
  maxOutputTokens: number;
}): UsdMicros {
  let lastPriced: UsageRecord | null = null;
  let lastWithTokens: UsageRecord | null = null;
  let total = 0;
  for (const r of input.records) {
    if (tokensOf(r)) lastWithTokens = r;
    if (r.costBasis === 'provider-reported' && r.costMicros !== null && Number.isFinite(r.costMicros)) {
      lastPriced = r;
      total += r.costMicros;
    }
  }
  const historyPrice = lastPriced && sameModel(input.model, lastPriced.model) ? highestBasePrice(lastPriced) : null;
  const configured = DEFAULT_PRICING[`anthropic:claude-${normalizeClaudeModel(input.model) ?? ''}`];
  const prices = input.pricing
    ? pricesFromPricing(input.pricing)
    : historyPrice !== null
      ? pricesFromBase(historyPrice)
      : configured
        ? pricesFromPricing(configured)
        : pricesFromBase(HIGHEST_INPUT_PRICE);

  const newTokens = estimateInputTokens(input.promptChars);
  const lastTokens = lastWithTokens ? tokensOf(lastWithTokens) : null;
  const context = lastTokens
    ? lastTokens.input + lastTokens.read + lastTokens.write + lastTokens.output + newTokens
    : input.records.length === 0
      ? newTokens + CLI_ADDED_TOKENS
      : null;

  const conversation =
    context !== null ? coldTurnMicros(prices, context, input.maxOutputTokens) : Math.max(2 * (lastPriced?.costMicros ?? 0), total);
  return Math.ceil(Math.max(input.pricingEstimate ?? 0, conversation, CLI_MIN_WORST_CASE_MICROS));
}

/** Worst-case cost of ONE attempt, or null when it cannot be bounded (no pricing, provider reports no cost). */
function worstCaseAttemptMicros(input: {
  capabilities: Pick<ProviderCapabilities, 'kind' | 'reportsCost'>;
  pricing: Pricing | null;
  model?: string | null;
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
    return cliWorstCase({
      pricing: input.pricing,
      pricingEstimate: estimate,
      model: input.model ?? null,
      records: input.records,
      promptChars: input.promptChars,
      maxOutputTokens: input.maxOutputTokens,
    });
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
  /** The session's configured model (an alias, a full id or null for the provider's default). */
  model?: string | null;
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
