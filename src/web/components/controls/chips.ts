/**
 * OWNER: betting-table agent (A5). Chip denominations offered to the manual player.
 * Display/convenience only: the server still validates every stake against the session limits.
 */
import type { SessionLimits, Subunits } from '../../../shared/contracts';

/** Standard chip values in subunits: V$ 0.10, 0.50, 1, 5, 25, 100. */
export const CHIP_DENOMINATIONS: readonly Subunits[] = Object.freeze([10, 50, 100, 500, 2500, 10000]);

/**
 * Chips usable under the session limits: >= minStake, a multiple of stakeIncrement and
 * <= maxStakePerBet (a bigger chip could never form a valid bet on its own).
 */
export function chipValuesFor(
  limits: Pick<SessionLimits, 'minStake' | 'stakeIncrement' | 'maxStakePerBet'>,
  denominations: readonly Subunits[] = CHIP_DENOMINATIONS,
): Subunits[] {
  const { minStake, stakeIncrement, maxStakePerBet } = limits;
  if (!Number.isSafeInteger(stakeIncrement) || stakeIncrement <= 0) return [];
  return denominations.filter(
    (v) => Number.isSafeInteger(v) && v >= minStake && v % stakeIncrement === 0 && (maxStakePerBet === null || v <= maxStakePerBet),
  );
}

/** Keep the selected chip valid when the allowed values change (fallback: smallest allowed chip). */
export function coerceChipValue(current: Subunits, values: readonly Subunits[]): Subunits | null {
  if (values.includes(current)) return current;
  return values.length > 0 ? values[0] : null;
}
