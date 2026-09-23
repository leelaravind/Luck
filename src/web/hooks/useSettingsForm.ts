/**
 * Settings editor state: default limits for new sessions, presentation preferences, the pause between
 * autonomous rounds and per-model pricing assumptions. Pricing is only ever used for ESTIMATED cost and is
 * always labelled as an assumption.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnimationSpeed, AppSettings, Pricing } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { useLimitsForm } from './useLimitsForm';

export interface PricingRow {
  /** `${kind}:${model}` */
  key: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  source: Pricing['source'];
  asOf: string;
  /** Edited in this form (source becomes 'user' on save). */
  dirty: boolean;
}

function num(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

export function pricingToRows(pricing: Record<string, Pricing>): PricingRow[] {
  return Object.entries(pricing)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, p]) => ({
      key,
      input: num(p.inputPerMTokUsd),
      output: num(p.outputPerMTokUsd),
      cacheRead: num(p.cacheReadPerMTokUsd),
      cacheWrite: num(p.cacheWritePerMTokUsd),
      source: p.source,
      asOf: p.asOf ?? '',
      dirty: false,
    }));
}

function parsePrice(text: string, required: boolean): number | null | undefined {
  const t = text.trim();
  if (!t) return required ? null : undefined;
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(t)) return null;
  return Number(t);
}

/** Server default for AppSettings.roundPacingMs (used when the server does not report a value). */
export const DEFAULT_ROUND_PACING_MS = 7000;
/** Accepted range for the pause between autonomous rounds, in seconds (0.1 s steps). */
export const ROUND_PACING_SEC = { min: 0, max: 600 } as const;

/** ms → the seconds text shown in the field ("7", "2.5"). */
export function pacingToInput(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/** Seconds text → integer ms, or an error message. */
export function parsePacing(text: string): { ms: number; error: null } | { ms: null; error: string } {
  const t = text.trim();
  const msg = `Enter seconds from ${ROUND_PACING_SEC.min} to ${ROUND_PACING_SEC.max}, e.g. 7 or 2.5 (one decimal at most).`;
  if (!/^\d{1,3}(?:\.\d)?$/.test(t)) return { ms: null, error: msg };
  const sec = Number(t);
  if (sec < ROUND_PACING_SEC.min || sec > ROUND_PACING_SEC.max) return { ms: null, error: msg };
  return { ms: Math.round(sec * 10) * 100, error: null };
}

/** Rows → Pricing map. Returns errors keyed by row key when a number is malformed. */
export function rowsToPricing(rows: readonly PricingRow[], today: string): { pricing: Record<string, Pricing>; errors: Record<string, string> } {
  const pricing: Record<string, Pricing> = {};
  const errors: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!/^[a-z-]+:.+$/.test(key)) {
      errors[r.key] = 'Key must look like "provider:model".';
      continue;
    }
    const input = parsePrice(r.input, true);
    const output = parsePrice(r.output, true);
    const cacheRead = parsePrice(r.cacheRead, false);
    const cacheWrite = parsePrice(r.cacheWrite, false);
    if (input === null || output === null || cacheRead === null || cacheWrite === null) {
      errors[r.key] = 'Prices are USD per million tokens, e.g. 3 or 0.25.';
      continue;
    }
    const p: Pricing = {
      inputPerMTokUsd: input!,
      outputPerMTokUsd: output!,
      source: r.dirty ? 'user' : r.source,
      asOf: r.dirty ? today : r.asOf || undefined,
    };
    if (cacheRead !== undefined) p.cacheReadPerMTokUsd = cacheRead;
    if (cacheWrite !== undefined) p.cacheWritePerMTokUsd = cacheWrite;
    pricing[key] = p;
  }
  return { pricing, errors };
}

export function useSettingsForm(settings: AppSettings | null) {
  const limitsForm = useLimitsForm(settings?.defaultLimits ?? DEFAULT_LIMITS);
  const [animationSpeed, setAnimationSpeed] = useState<AnimationSpeed>(settings?.animationSpeed ?? 'normal');
  const [reduceMotion, setReduceMotion] = useState<AppSettings['reduceMotion']>(settings?.reduceMotion ?? 'system');
  const serverPacingMs = settings?.roundPacingMs ?? DEFAULT_ROUND_PACING_MS;
  const [pacingSec, setPacingSec] = useState(() => pacingToInput(serverPacingMs));
  const [rows, setRows] = useState<PricingRow[]>(() => pricingToRows(settings?.pricing ?? {}));

  // Re-sync when the server's settings change (e.g. after a save or first load).
  const { reset } = limitsForm;
  useEffect(() => {
    if (!settings) return;
    reset(settings.defaultLimits);
    setAnimationSpeed(settings.animationSpeed);
    setReduceMotion(settings.reduceMotion);
    setPacingSec(pacingToInput(settings.roundPacingMs ?? DEFAULT_ROUND_PACING_MS));
    setRows(pricingToRows(settings.pricing ?? {}));
  }, [settings, reset]);

  const updateRow = useCallback((key: string, field: keyof Omit<PricingRow, 'key' | 'dirty' | 'source' | 'asOf'>, value: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value, dirty: true } : r)));
  }, []);
  const addRow = useCallback((key: string) => {
    setRows((rs) =>
      rs.some((r) => r.key === key)
        ? rs
        : [...rs, { key, input: '', output: '', cacheRead: '', cacheWrite: '', source: 'user', asOf: '', dirty: true }],
    );
  }, []);
  /** Only user entries can be removed; default assumptions always come back from the server. */
  const removeRow = useCallback(
    (key: string) => setRows((rs) => rs.filter((r) => r.key !== key || r.source === 'default-assumption')),
    [],
  );

  const today = new Date().toISOString().slice(0, 10);
  const pricingParsed = useMemo(() => rowsToPricing(rows, today), [rows, today]);

  const pacing = parsePacing(pacingSec);

  let patch: Partial<AppSettings> | null = null;
  if (limitsForm.limits && !Object.keys(pricingParsed.errors).length && pacing.ms !== null) {
    // Pricing = exactly the rows listed. The server treats the map as the COMPLETE set of user entries (it
    // ignores unedited copies of its built-in defaults), so a removed row stays removed after the save.
    patch = { defaultLimits: limitsForm.limits, animationSpeed, reduceMotion, pricing: pricingParsed.pricing };
    // Partial update: sent only when it differs from the server's value (the server keeps its value otherwise).
    if (pacing.ms !== serverPacingMs) patch.roundPacingMs = pacing.ms;
  }

  return {
    limitsForm,
    animationSpeed,
    setAnimationSpeed,
    reduceMotion,
    setReduceMotion,
    pacingSec,
    setPacingSec,
    pacingError: pacing.error,
    rows,
    updateRow,
    addRow,
    removeRow,
    pricingErrors: pricingParsed.errors,
    patch,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
