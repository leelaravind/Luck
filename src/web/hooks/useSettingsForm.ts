/**
 * Settings editor state: default limits for new sessions, presentation preferences, the pause between
 * autonomous rounds and per-model pricing assumptions. Pricing is only ever used for ESTIMATED cost and is
 * always labelled as an assumption.
 *
 * The save patch (AppSettingsPatch) carries only what the user changed in this form, so a tab whose copy
 * of the settings is older than the server's cannot overwrite values it never touched:
 *  - defaultLimits / animationSpeed / reduceMotion / roundPacingMs: sent only when they differ from the
 *    loaded server value;
 *  - pricing: only the rows edited or added here (the server MERGES them key by key);
 *  - pricingRemove: the keys removed here that the server listed, plus built-in keys whose user override is
 *    being reset ("Reset to default"); a built-in default itself is never deleted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnimationSpeed, AppSettings, AppSettingsPatch, Pricing } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { limitsToValues, useLimitsForm, type LimitField } from './useLimitsForm';

export interface PricingRow {
  /** `${kind}:${model}` */
  key: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  source: Pricing['source'];
  asOf: string;
  /**
   * A built-in default pricing key (AppSettings.builtInPricingKeys): it cannot be removed, only reset to the
   * default when the user overrode it. Every other row can be removed, whatever its `source`.
   */
  builtIn: boolean;
  /** Edited in this form (source becomes 'user' on save). */
  dirty: boolean;
  /** A built-in row whose user override will be dropped on save (it returns to the built-in default). */
  resetPending?: boolean;
}

function num(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

export function pricingToRows(pricing: Record<string, Pricing>, builtInKeys: readonly string[] = []): PricingRow[] {
  const builtIn = new Set(builtInKeys);
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
      builtIn: builtIn.has(key),
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

const NO_KEYS: readonly string[] = [];

export function useSettingsForm(settings: AppSettings | null) {
  const serverLimits = settings?.defaultLimits ?? DEFAULT_LIMITS;
  const limitsForm = useLimitsForm(serverLimits);
  const [animationSpeed, setAnimationSpeed] = useState<AnimationSpeed>(settings?.animationSpeed ?? 'normal');
  const [reduceMotion, setReduceMotion] = useState<AppSettings['reduceMotion']>(settings?.reduceMotion ?? 'system');
  const serverPacingMs = settings?.roundPacingMs ?? DEFAULT_ROUND_PACING_MS;
  const [pacingSec, setPacingSec] = useState(() => pacingToInput(serverPacingMs));
  const builtInKeys = settings?.builtInPricingKeys ?? NO_KEYS;
  /**
   * The pricing rows and the keys removed in this form since the settings were last loaded (sent as
   * `pricingRemove`). One state, so every action updates both together, also when several run in one batch.
   */
  const [pricingState, setPricingState] = useState<{ rows: PricingRow[]; removed: readonly string[] }>(() => ({
    rows: pricingToRows(settings?.pricing ?? {}, builtInKeys),
    removed: NO_KEYS,
  }));
  const { rows, removed } = pricingState;

  // Re-sync when the server's settings change (after a save, the first load or a refresh).
  const { reset } = limitsForm;
  useEffect(() => {
    if (!settings) return;
    reset(settings.defaultLimits);
    setAnimationSpeed(settings.animationSpeed);
    setReduceMotion(settings.reduceMotion);
    setPacingSec(pacingToInput(settings.roundPacingMs ?? DEFAULT_ROUND_PACING_MS));
    setPricingState({ rows: pricingToRows(settings.pricing ?? {}, settings.builtInPricingKeys ?? NO_KEYS), removed: NO_KEYS });
  }, [settings, reset]);

  const updateRow = useCallback(
    (key: string, field: 'input' | 'output' | 'cacheRead' | 'cacheWrite', value: string) => {
      // Editing a row cancels a pending "Reset to default" for it.
      setPricingState((p) => ({
        rows: p.rows.map((r) => (r.key === key ? { ...r, [field]: value, dirty: true, resetPending: false } : r)),
        removed: p.removed.includes(key) && builtInKeys.includes(key) ? p.removed.filter((k) => k !== key) : p.removed,
      }));
    },
    [builtInKeys],
  );
  const addRow = useCallback(
    (key: string) => {
      setPricingState((p) => {
        // A key already in the table is left alone, including a pending "Reset to default" on it.
        if (p.rows.some((r) => r.key === key)) return p;
        return {
          rows: [
            ...p.rows,
            { key, input: '', output: '', cacheRead: '', cacheWrite: '', source: 'user', asOf: '', builtIn: builtInKeys.includes(key), dirty: true },
          ],
          // Added again after a removal: it is saved as a new value, not deleted.
          removed: p.removed.filter((k) => k !== key),
        };
      });
    },
    [builtInKeys],
  );
  /**
   * A built-in row the user overrode (source 'user') can be reset: the override is dropped on save
   * (sent in pricingRemove) and the row returns to the built-in default. Editing the row again cancels it.
   */
  const resetRow = useCallback(
    (key: string) => {
      if (!builtInKeys.includes(key)) return;
      setPricingState((p) => ({
        rows: p.rows.map((r) => (r.key === key && r.source === 'user' ? { ...r, resetPending: true, dirty: false } : r)),
        removed: p.removed.includes(key) ? p.removed : [...p.removed, key],
      }));
    },
    [builtInKeys],
  );
  /** Every row except a built-in default key can be removed (decided by key, not by `source`). */
  const removeRow = useCallback(
    (key: string) => {
      if (builtInKeys.includes(key)) return;
      setPricingState((p) => ({
        rows: p.rows.filter((r) => r.key !== key),
        removed: p.removed.includes(key) ? p.removed : [...p.removed, key],
      }));
    },
    [builtInKeys],
  );

  const today = new Date().toISOString().slice(0, 10);
  // Only rows edited or added here are sent (and validated): untouched rows are the server's own values.
  const pricingParsed = useMemo(() => rowsToPricing(rows.filter((r) => r.dirty), today), [rows, today]);
  // Only keys the server listed need deleting; a row added and removed here never reached the server.
  const serverPricing = settings?.pricing;
  const pricingRemove = useMemo(
    () =>
      removed.filter(
        (k) =>
          !!serverPricing &&
          Object.hasOwn(serverPricing, k) &&
          // Built-in keys are sent only to drop a user override ("Reset to default").
          (!builtInKeys.includes(k) || serverPricing[k]?.source === 'user'),
      ),
    [removed, serverPricing, builtInKeys],
  );

  const pacing = parsePacing(pacingSec);
  const serverLimitValues = useMemo(() => limitsToValues(serverLimits), [serverLimits]);
  const limitsChanged = (Object.keys(serverLimitValues) as LimitField[]).some((f) => limitsForm.values[f] !== serverLimitValues[f]);

  let patch: AppSettingsPatch | null = null;
  if (limitsForm.limits && !Object.keys(pricingParsed.errors).length && pacing.ms !== null) {
    // Partial update: each field is sent only when it differs from the loaded server value, so saving from
    // a tab with an older copy cannot overwrite what another tab saved in the meantime.
    const next: AppSettingsPatch = {};
    if (limitsChanged) next.defaultLimits = limitsForm.limits;
    if (settings && animationSpeed !== settings.animationSpeed) next.animationSpeed = animationSpeed;
    if (settings && reduceMotion !== settings.reduceMotion) next.reduceMotion = reduceMotion;
    if (pacing.ms !== serverPacingMs && pacingSec !== pacingToInput(serverPacingMs)) next.roundPacingMs = pacing.ms;
    if (Object.keys(pricingParsed.pricing).length) next.pricing = pricingParsed.pricing;
    if (pricingRemove.length) next.pricingRemove = pricingRemove;
    patch = next;
  }
  /** The form holds changes that are not saved yet (or input that is not valid). */
  const unsaved = patch === null || Object.keys(patch).length > 0;

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
    resetRow,
    pricingErrors: pricingParsed.errors,
    patch,
    unsaved,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
