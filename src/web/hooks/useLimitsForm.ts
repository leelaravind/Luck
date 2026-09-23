/**
 * Editable session limits. Credit amounts are typed as decimals and parsed with parseCredits into integer
 * subunits (no floating point); the budget is typed in USD and parsed into integer micro-USD.
 * Only the format is checked here — the server validates the limits authoritatively.
 */
import { useCallback, useMemo, useState } from 'react';
import type { SessionLimits } from '../../shared/contracts';
import { parseCredits } from '../../shared/money';
import { microsToUsdInput, parseUsdToMicros, subunitsToInput } from '../state/format';

export const CREDIT_FIELDS = ['startingBalance', 'minStake', 'stakeIncrement', 'maxStakePerBet', 'maxStakePerRound'] as const;
export const INT_FIELDS = ['maxBetsPerRound', 'maxOutputTokens', 'maxRetries', 'maxConsecutiveFailures', 'historyWindow'] as const;
export const OPTIONAL_FIELDS = ['maxRounds', 'maxRuntimeMin', 'budgetUsd'] as const;
export const SECONDS_FIELDS = ['decisionTimeoutSec'] as const;
/** Checkbox fields stored as 'true' / 'false'. */
export const FLAG_FIELDS = ['allowModelStop'] as const;

export type LimitField =
  | (typeof CREDIT_FIELDS)[number]
  | (typeof INT_FIELDS)[number]
  | (typeof OPTIONAL_FIELDS)[number]
  | (typeof SECONDS_FIELDS)[number]
  | (typeof FLAG_FIELDS)[number];

export type LimitsValues = Record<LimitField, string>;
export type LimitsErrors = Partial<Record<LimitField, string>>;

const MIN_INT: Record<(typeof INT_FIELDS)[number], number> = {
  maxBetsPerRound: 1,
  maxOutputTokens: 1,
  maxRetries: 0,
  maxConsecutiveFailures: 1,
  historyWindow: 0,
};

function trimDecimal(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function limitsToValues(l: SessionLimits): LimitsValues {
  return {
    startingBalance: subunitsToInput(l.startingBalance),
    minStake: subunitsToInput(l.minStake),
    stakeIncrement: subunitsToInput(l.stakeIncrement),
    maxStakePerBet: subunitsToInput(l.maxStakePerBet),
    maxStakePerRound: subunitsToInput(l.maxStakePerRound),
    maxBetsPerRound: String(l.maxBetsPerRound),
    maxRounds: l.maxRounds === null ? '' : String(l.maxRounds),
    maxRuntimeMin: l.maxRuntimeSec === null ? '' : trimDecimal(l.maxRuntimeSec / 60),
    budgetUsd: l.budgetMicros === null ? '' : microsToUsdInput(l.budgetMicros),
    maxOutputTokens: String(l.maxOutputTokens),
    decisionTimeoutSec: trimDecimal(l.decisionTimeoutMs / 1000),
    maxRetries: String(l.maxRetries),
    maxConsecutiveFailures: String(l.maxConsecutiveFailures),
    historyWindow: String(l.historyWindow),
    allowModelStop: l.allowModelStop ? 'true' : 'false',
  };
}

function parseInt10(text: string): number | null {
  return /^\s*\d{1,9}\s*$/.test(text) ? Number(text.trim()) : null;
}

function parseDecimal(text: string): number | null {
  return /^\s*\d{1,9}(?:\.\d{1,3})?\s*$/.test(text) ? Number(text.trim()) : null;
}

/** Parse the form. Returns limits only when every field is well-formed. */
export function valuesToLimits(v: LimitsValues): { limits: SessionLimits | null; errors: LimitsErrors } {
  const errors: LimitsErrors = {};
  const credits: Partial<Record<(typeof CREDIT_FIELDS)[number], number>> = {};
  for (const f of CREDIT_FIELDS) {
    const n = parseCredits(v[f]);
    if (n === null) errors[f] = 'Enter an amount like 10 or 0.50 (max 2 decimals).';
    else if (n <= 0) errors[f] = 'Must be greater than 0.';
    else credits[f] = n;
  }
  const ints: Partial<Record<(typeof INT_FIELDS)[number], number>> = {};
  for (const f of INT_FIELDS) {
    const n = parseInt10(v[f]);
    if (n === null) errors[f] = 'Enter a whole number.';
    else if (n < MIN_INT[f]) errors[f] = `Must be at least ${MIN_INT[f]}.`;
    else ints[f] = n;
  }
  let maxRounds: number | null = null;
  if (v.maxRounds.trim()) {
    const n = parseInt10(v.maxRounds);
    if (n === null || n < 1) errors.maxRounds = 'Enter a whole number ≥ 1, or leave blank for unlimited.';
    else maxRounds = n;
  }
  let maxRuntimeSec: number | null = null;
  if (v.maxRuntimeMin.trim()) {
    const n = parseDecimal(v.maxRuntimeMin);
    if (n === null || n <= 0) errors.maxRuntimeMin = 'Enter minutes > 0, or leave blank for unlimited.';
    else maxRuntimeSec = Math.round(n * 60);
  }
  let budgetMicros: number | null = null;
  if (v.budgetUsd.trim()) {
    const n = parseUsdToMicros(v.budgetUsd);
    if (n === null) errors.budgetUsd = 'Enter USD like 0.25 (max 6 decimals), or leave blank for none.';
    else budgetMicros = n;
  }
  let decisionTimeoutMs = 0;
  const t = parseDecimal(v.decisionTimeoutSec);
  if (t === null || t <= 0) errors.decisionTimeoutSec = 'Enter seconds > 0.';
  else decisionTimeoutMs = Math.round(t * 1000);

  if (Object.keys(errors).length) return { limits: null, errors };
  return {
    errors,
    limits: {
      startingBalance: credits.startingBalance!,
      minStake: credits.minStake!,
      stakeIncrement: credits.stakeIncrement!,
      maxStakePerBet: credits.maxStakePerBet!,
      maxStakePerRound: credits.maxStakePerRound!,
      maxBetsPerRound: ints.maxBetsPerRound!,
      maxRounds,
      maxRuntimeSec,
      maxOutputTokens: ints.maxOutputTokens!,
      budgetMicros,
      decisionTimeoutMs,
      maxRetries: ints.maxRetries!,
      maxConsecutiveFailures: ints.maxConsecutiveFailures!,
      historyWindow: ints.historyWindow!,
      allowModelStop: v.allowModelStop === 'true',
    },
  };
}

export function useLimitsForm(initial: SessionLimits) {
  const [values, setValues] = useState<LimitsValues>(() => limitsToValues(initial));
  const setValue = useCallback((field: LimitField, value: string) => setValues((v) => ({ ...v, [field]: value })), []);
  const reset = useCallback((limits: SessionLimits) => setValues(limitsToValues(limits)), []);
  const parsed = useMemo(() => valuesToLimits(values), [values]);
  return { values, setValue, reset, limits: parsed.limits, errors: parsed.errors };
}

export type LimitsForm = ReturnType<typeof useLimitsForm>;
