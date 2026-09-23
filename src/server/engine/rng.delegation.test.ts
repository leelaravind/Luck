/**
 * Verifies that the production outcome source draws from node:crypto randomInt(0, 37).
 * node:crypto is wrapped with a spy that still calls the REAL randomInt unless a single call is
 * overridden, so this file checks delegation and pass-through; uniformity is tested in rng.test.ts.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn((min: number, max: number) => actual.randomInt(min, max)) };
});

import { randomInt } from 'node:crypto';
import { createCryptoOutcomeSource } from './rng.js';

const spy = randomInt as unknown as Mock<(min: number, max: number) => number>;

afterEach(() => {
  spy.mockClear();
});

describe('createCryptoOutcomeSource delegates to crypto.randomInt', () => {
  it('calls randomInt(0, 37) exactly once per draw', () => {
    const source = createCryptoOutcomeSource();
    for (let i = 0; i < 50; i++) {
      const n = source.next();
      expect(Number.isInteger(n) && n >= 0 && n <= 36).toBe(true);
    }
    expect(spy).toHaveBeenCalledTimes(50);
    for (const call of spy.mock.calls) expect(call).toEqual([0, 37]);
  });

  it('returns exactly what randomInt returned', () => {
    const source = createCryptoOutcomeSource();
    for (const v of [0, 17, 36]) {
      spy.mockImplementationOnce(() => v);
      expect(source.next()).toBe(v);
    }
  });

  it('refuses to pass on an out-of-range value (defensive guard)', () => {
    const source = createCryptoOutcomeSource();
    spy.mockImplementationOnce(() => 37);
    expect(() => source.next()).toThrow(/out-of-range/);
  });

  it('draws nothing until next() is called', () => {
    createCryptoOutcomeSource();
    expect(spy).not.toHaveBeenCalled();
  });
});
