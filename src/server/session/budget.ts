/**
 * Conservative, pre-request budget enforcement for PAID providers.
 *
 * Before EVERY attempt the runner asks: could this call push spending past the app budget?
 *   worst case = worstCaseCostMicros(ceil(promptChars / 2), maxOutputTokens, pricing)
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
/**
 * Conservative characters-per-token ratio for the input estimate: English prose is ~4, but the observation is
 * JSON with many digits, and newer Claude tokenizers produce up to ~35% more tokens for the same text.
 */
const CHARS_PER_TOKEN_ESTIMATE = 2;

/** Attempts that may have been billed even though no cost was reported. */
// Only 'rate_limited' is excluded: a 429 is rejected before any work is done. 'error' is included on
// purpose (reviewer D1): errors after the request was sent may still have been processed and billed.
const MAYBE_BILLED: ReadonlySet<UsageAttemptStatus> = new Set(['ok', 'invalid_output', 'timeout', 'cancelled', 'stale', 'error']);

export function estimateInputTokens(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * One Claude Code CLI run (one Luck decision) can make up to CLI_MAX_CALLS API calls: `--max-turns 2`
 * allows two turns (the second when the CLI makes the model call its StructuredOutput tool again), and
 * in each turn the CLI continues up to 3 times after the output cap is hit and nudges once after an
 * answer that only thinks (Claude Code 2.1.280; see docs/providers-cli-laya.md) — 2 × (1 + 3 + 1).
 * Each later call re-sends the context and the answers so far and adds the previous answer plus a short
 * message (at most CLI_CONTINUATION_TOKENS) as new input.
 */
const CLI_MAX_CALLS = 10;
const CLI_CONTINUATION_TOKENS = 200;
/**
 * Context the CLI adds to the first turn besides Luck's prompt: its environment, date, model and
 * budget entries, the opening message and the JSON schema (the one live measurement: 2 971 input
 * tokens for a 5 409-character prompt).
 */
const CLI_ADDED_TOKENS = 3_000;
/**
 * Below the minimum cacheable prompt (4 096 tokens for some Claude models) nothing is cached, so a
 * later call re-sends the context at the full input price. The context estimate can be up to about
 * 2.5× the real count (1 token per 2 characters and 3 000 added tokens against ~4 and ~1 200), so
 * estimates below 3 × 4 096 are priced that way.
 */
const UNCACHED_CONTEXT_TOKENS = 3 * 4_096;

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
/**
 * Price ceiling (µ$ per token = $ per MTok of base input) for a turn whose model price is not known: the
 * dearest Claude list price, $15/MTok input (Claude Opus 4 / 4.1, still listed), or a dearer built-in one.
 */
const CEILING_INPUT_PRICE = Math.max(
  15,
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
  input: number;
  read: number;
  write: number;
  output: number;
}

/** Claude price structure on a base input price: read ≤ 0.1×, 1-hour cache write 2×, output 5×. */
function pricesFromBase(input: number): TurnPrices {
  return { input, read: 0.1 * input, write: 2 * input, output: 5 * input };
}

/** A pricing entry, conservatively: a missing read rate = input, a write at least the 1-hour 2×. */
function pricesFromPricing(p: Pricing): TurnPrices {
  const input = p.inputPerMTokUsd;
  return {
    input,
    read: p.cacheReadPerMTokUsd ?? input,
    write: Math.max(p.cacheWritePerMTokUsd ?? 1.25 * input, 2 * input),
    output: p.outputPerMTokUsd,
  };
}

/** Rate by rate the dearest of the candidates: a lower candidate can never lower the bound. */
function dearest(candidates: readonly TurnPrices[]): TurnPrices {
  return {
    input: Math.max(...candidates.map((c) => c.input)),
    read: Math.max(...candidates.map((c) => c.read)),
    write: Math.max(...candidates.map((c) => c.write)),
    output: Math.max(...candidates.map((c) => c.output)),
  };
}

/** All four token counts of an attempt, or null when any is unreported or all are zero (an empty error result). */
function tokensOf(r: UsageRecord): { input: number; read: number; write: number; output: number } | null {
  if (!r.known || r.inputTokens === null || r.outputTokens === null || r.cacheReadTokens === null || r.cacheWriteTokens === null) return null;
  const t = { input: r.inputTokens, read: r.cacheReadTokens, write: r.cacheWriteTokens, output: r.outputTokens };
  return t.input + t.read + t.write + t.output > 0 ? t : null;
}

/**
 * The highest base input price a turn's CLI-reported cost allows: its cost divided by its tokens,
 * each weighted with the CHEAPEST rate its class can have for that model (cache read at the model's
 * ratio, cache write 1.25×, output 4× although Claude charges 5×). Null without cost or tokens.
 */
function highestBasePrice(r: UsageRecord): number | null {
  const t = tokensOf(r);
  if (!t || r.costMicros === null || !(r.costMicros > 0) || !Number.isFinite(r.costMicros)) return null;
  const ratio = CACHE_READ_RATIO[normalizeClaudeModel(r.model) ?? ''] ?? LOWEST_CACHE_READ_RATIO;
  const weighted = t.input + ratio * t.read + 1.25 * t.write + 4 * t.output;
  return weighted > 0 ? r.costMicros / weighted : null;
}

/**
 * A run whose prompt cache has expired, call by call: the first call writes the whole context and
 * answers with the full output cap; each later call re-reads the context and the earlier answers (at
 * the full input price unless the context is surely large enough to be cached), writes the previous
 * answer plus a short message as new input, and answers with the full cap again.
 */
function coldTurnMicros(p: TurnPrices, contextTokens: number, maxOutputTokens: number, cacheable: boolean): number {
  const out = Math.max(0, maxOutputTokens);
  const reread = cacheable ? p.read : p.input;
  let cost = p.write * contextTokens + p.output * out;
  for (let call = 2; call <= CLI_MAX_CALLS; call++) {
    const earlierAnswers = (call - 2) * (out + CLI_CONTINUATION_TOKENS);
    cost += reread * (contextTokens + earlierAnswers) + p.write * (out + CLI_CONTINUATION_TOKENS) + p.output * out;
  }
  return cost;
}

/**
 * Worst case of one Claude Code CLI turn. The CLI resumes ONE conversation per session and re-sends
 * every earlier turn, so the current prompt alone under-estimates the input (reviewer A11b-N5), and
 * the last turn's cost is no bound either: a warm turn is mostly cheap cache reads, but once the
 * prompt cache has expired (e.g. a session resumed after a long pause) the whole context is written
 * again at the cache-write price — up to 80× a cache read on Claude Fable 5.1.
 *
 * Prices of the next turn, rate by rate the dearest of: the pricing assumption; the highest base price
 * the last priced turn's cost allows (highestBasePrice), when it was made with the configured model;
 * the configured model's built-in price. When neither of the last two is available, the ceiling price
 * is added. Context: the largest context a turn reported with its four token counts (the conversation
 * only grows; the largest does not depend on the order of the records) plus the new prompt, or — with
 * no such turn (the first turn, or only failed attempts whose conversation the CLI discarded) — the new
 * prompt plus what the CLI adds; either way plus, for every attempt without token counts after the last
 * counted one, what that attempt may have added (a prompt and its answers). Priced as a cold run
 * (coldTurnMicros). When the
 * last priced turn reported no tokens, the older rule max(2 × the last turn, the total so far) can only
 * raise it. The result is at least the pricing estimate and the 50 000 µ$ floor.
 *
 * Limits (documented): with no model configured, or an alias, the CLI may switch to a dearer model
 * between two turns (e.g. after a CLI update); the CLI's automatic compaction of a very long
 * conversation and its retry after a malformed tool call are extra calls not modelled here. The CLI's
 * own --max-budget-usd stop (the remaining budget) still ends such a run after the API call in progress.
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
  let lastWithTokens = -1;
  let largestContext: number | null = null;
  let total = 0;
  input.records.forEach((r, i) => {
    const t = tokensOf(r);
    if (t) {
      lastWithTokens = i;
      largestContext = Math.max(largestContext ?? 0, t.input + t.read + t.write + t.output);
    }
    if (r.costBasis === 'provider-reported' && r.costMicros !== null && Number.isFinite(r.costMicros)) {
      lastPriced = r;
      total += r.costMicros;
    }
  });
  const priced = lastPriced as UsageRecord | null;

  const historyPrice = priced && sameModel(input.model, priced.model) ? highestBasePrice(priced) : null;
  const builtIn = DEFAULT_PRICING[`anthropic:claude-${normalizeClaudeModel(input.model) ?? ''}`];
  const candidates: TurnPrices[] = [];
  if (input.pricing) candidates.push(pricesFromPricing(input.pricing));
  if (historyPrice !== null) candidates.push(pricesFromBase(historyPrice));
  if (builtIn) candidates.push(pricesFromPricing(builtIn));
  if (historyPrice === null && !builtIn) candidates.push(pricesFromBase(CEILING_INPUT_PRICE));
  const prices = dearest(candidates);

  const out = Math.max(0, input.maxOutputTokens);
  const newTokens = estimateInputTokens(input.promptChars);
  const laterAttempts = input.records.length - 1 - lastWithTokens;
  // Whether the context is surely cacheable is decided without the margins for later attempts: an attempt
  // that failed may have added nothing (the CLI discards a conversation whose first turn failed).
  const known = ((largestContext as number | null) ?? CLI_ADDED_TOKENS) + newTokens;
  const context = known + laterAttempts * (newTokens + CLI_MAX_CALLS * (out + CLI_CONTINUATION_TOKENS));

  let conversation = coldTurnMicros(prices, context, out, known >= UNCACHED_CONTEXT_TOKENS);
  if (priced && !tokensOf(priced)) conversation = Math.max(conversation, 2 * (priced.costMicros ?? 0), total);
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
    const worst = cliWorstCase({
      pricing: input.pricing,
      pricingEstimate: estimate,
      model: input.model ?? null,
      records: input.records,
      promptChars: input.promptChars,
      maxOutputTokens: input.maxOutputTokens,
    });
    // A non-finite bound (e.g. a NaN input) cannot be compared with the budget: treat it as unboundable.
    return Number.isFinite(worst) ? worst : null;
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
