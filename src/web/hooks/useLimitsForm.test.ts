// Unit tests for limits parsing (credits via parseCredits → integer subunits; USD → integer micro-USD).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { microsToUsdInput, parseUsdToMicros } from '../state/format';
import { limitsToValues, valuesToLimits } from './useLimitsForm';

describe('limits form', () => {
  it('round-trips DEFAULT_LIMITS exactly', () => {
    const { limits, errors } = valuesToLimits(limitsToValues(DEFAULT_LIMITS));
    expect(errors).toEqual({});
    expect(limits).toEqual(DEFAULT_LIMITS);
  });

  it('parses decimal credits into integer subunits without floating point drift', () => {
    const v = { ...limitsToValues(DEFAULT_LIMITS), startingBalance: '0.29', minStake: '0.1', maxStakePerBet: '12.30' };
    const { limits } = valuesToLimits(v);
    expect(limits?.startingBalance).toBe(29);
    expect(limits?.minStake).toBe(10);
    expect(limits?.maxStakePerBet).toBe(1230);
  });

  it('rejects malformed values with per-field errors and returns no limits', () => {
    const v = { ...limitsToValues(DEFAULT_LIMITS), minStake: '1.005', maxBetsPerRound: '0', maxRounds: 'abc', budgetUsd: '-1' };
    const { limits, errors } = valuesToLimits(v);
    expect(limits).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['budgetUsd', 'maxBetsPerRound', 'maxRounds', 'minStake']);
  });

  it('treats blank optional fields as unlimited / no budget', () => {
    const v = { ...limitsToValues(DEFAULT_LIMITS), maxRounds: '', maxRuntimeMin: '', budgetUsd: '' };
    const { limits } = valuesToLimits(v);
    expect(limits).toMatchObject({ maxRounds: null, maxRuntimeSec: null, budgetMicros: null });
  });

  it('parses USD into integer micro-USD', () => {
    expect(parseUsdToMicros('0.25')).toBe(250_000);
    expect(parseUsdToMicros('$5')).toBe(5_000_000);
    expect(parseUsdToMicros('0.000001')).toBe(1);
    expect(parseUsdToMicros('1e3')).toBeNull();
    expect(parseUsdToMicros('0.0000001')).toBeNull();
    expect(microsToUsdInput(250_000)).toBe('0.25');
    expect(microsToUsdInput(5_000_000)).toBe('5');
  });
});
