/**
 * Statistical sanity checks of the PRODUCTION outcome source against the real node:crypto CSPRNG
 * (no mocks in this file). Thresholds are deliberately generous so an honest RNG essentially
 * never fails (false-failure probability per run is roughly 1e-5 or lower), while a biased,
 * constant or round-robin source fails immediately.
 */
import { describe, expect, it } from 'vitest';
import { createCryptoOutcomeSource } from './rng.js';

const DRAWS = 370_000; // 10,000 expected per pocket
const POCKETS = 37;

describe('createCryptoOutcomeSource (real crypto.randomInt)', () => {
  it('is labelled as the crypto source', () => {
    expect(createCryptoOutcomeSource().kind).toBe('crypto');
  });

  it(`${DRAWS} draws: integers in 0..36, uniform by chi-square, no obvious serial pattern`, () => {
    const source = createCryptoOutcomeSource();
    const counts = new Array<number>(POCKETS).fill(0);
    let repeats = 0;
    let previous = -1;
    for (let i = 0; i < DRAWS; i++) {
      const n = source.next();
      if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error(`draw ${i} out of range: ${n}`);
      counts[n]++;
      if (n === previous) repeats++;
      previous = n;
    }

    const expected = DRAWS / POCKETS;
    const chiSquare = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);

    // df = 36. P(chi² > 100) ≈ 1e-7 and P(chi² < 10) ≈ 1e-5 for a uniform source.
    expect(chiSquare).toBeLessThan(100);
    expect(chiSquare).toBeGreaterThan(10); // a perfectly even (e.g. round-robin) sequence is not random
    // Each pocket within ±6 % of 10,000 (the standard deviation is ~99, so this is ~6σ).
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.94);
      expect(c).toBeLessThan(expected * 1.06);
    }
    // Immediate repeats should occur ~1/37 of the time (~10,000; σ ≈ 99).
    expect(repeats).toBeGreaterThan(9_000);
    expect(repeats).toBeLessThan(11_000);
  });

  it('independent sources are not correlated (no shared seed)', () => {
    const a = createCryptoOutcomeSource();
    const b = createCryptoOutcomeSource();
    let same = 0;
    const N = 37_000;
    for (let i = 0; i < N; i++) if (a.next() === b.next()) same++;
    // Expected ~1,000 matches (1/37); identical streams would give 37,000.
    expect(same).toBeGreaterThan(700);
    expect(same).toBeLessThan(1_300);
  });
});
