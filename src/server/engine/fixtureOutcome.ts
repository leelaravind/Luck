/**
 * OWNER: rules agent (A2). TEST-ONLY deterministic outcome source.
 *
 * NEVER used by production wiring: the server always draws winning numbers with
 * createCryptoOutcomeSource() from ./rng.ts. This module is intentionally not re-exported from
 * ./index.ts; tests import it explicitly and inject it where an OutcomeSource is accepted.
 * As a second guard it refuses to be constructed when NODE_ENV === 'production'.
 *
 * Behaviour: next() returns the scripted numbers in order and throws once they run out, so a
 * test fails loudly if the code under test draws more outcomes than expected (or draws one at
 * all, with an empty script).
 */
import { isRouletteNumber } from '../../shared/roulette.js';
import type { OutcomeSource } from '../types.js';

export interface FixtureOutcomeSource extends OutcomeSource {
  readonly kind: 'fixture';
  /** How many times next() has been called, including a call that threw because the script ran out. */
  readonly calls: number;
  /** Scripted outcomes not yet returned. */
  readonly remaining: number;
}

export function createFixtureOutcomeSource(seq: number[]): FixtureOutcomeSource {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Fixture outcome source is test-only and cannot be used when NODE_ENV=production');
  }
  if (!Array.isArray(seq)) throw new TypeError('Fixture outcome sequence must be an array of numbers 0-36');
  seq.forEach((n, i) => {
    if (!isRouletteNumber(n)) {
      throw new RangeError(`Fixture outcome #${i} (${String(n)}) is not a roulette number (whole numbers 0-36)`);
    }
  });

  const script = [...seq]; // copy: later mutation of the caller's array has no effect
  let calls = 0;
  let served = 0;

  return {
    kind: 'fixture',
    get calls() {
      return calls;
    },
    get remaining() {
      return script.length - served;
    },
    next(): number {
      calls++;
      if (served >= script.length) {
        throw new Error(`Fixture outcome source exhausted: all ${script.length} scripted outcome(s) were already used`);
      }
      return script[served++];
    },
  };
}
