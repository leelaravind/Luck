/**
 * Chip denominations for manual play, filtered to what the session limits allow
 * (>= minStake, a multiple of stakeIncrement, <= maxStakePerBet). The server re-validates every stake.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SessionLimits, Subunits } from '../../shared/contracts';

/** V$ 0.10, 0.50, 1, 5, 25, 100 (the denominations shown in the Stitch reference). */
export const STANDARD_CHIPS: readonly Subunits[] = [10, 50, 100, 500, 2_500, 10_000];

export function chipValuesFor(limits: SessionLimits): Subunits[] {
  const allowed = STANDARD_CHIPS.filter(
    (v) => v >= limits.minStake && v <= limits.maxStakePerBet && limits.stakeIncrement > 0 && v % limits.stakeIncrement === 0,
  );
  if (allowed.length) return allowed;
  // Fall back to the smallest legal stake.
  const inc = Math.max(1, limits.stakeIncrement);
  return [Math.ceil(limits.minStake / inc) * inc];
}

export function useChips(limits: SessionLimits) {
  const values = useMemo(() => chipValuesFor(limits), [limits]);
  const [chipValue, setChipValue] = useState<Subunits>(values[0]!);
  useEffect(() => {
    if (!values.includes(chipValue)) setChipValue(values[0]!);
  }, [values, chipValue]);
  return { chipValues: values, chipValue: values.includes(chipValue) ? chipValue : values[0]!, setChipValue };
}
