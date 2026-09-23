/**
 * OWNER: rules agent (A2). Production outcome source for winning numbers.
 *
 * Uses node:crypto randomInt(0, 37), which draws from the operating system CSPRNG and samples
 * uniformly over [0, 37) without modulo bias (Node uses rejection sampling), so every pocket
 * 0..36 has probability exactly 1/37. There is no seed and no retained state: nothing exists
 * that a model, the UI or a log could observe to predict the next outcome.
 *
 * The session layer must call next() only AFTER the round's bets are committed (persisted).
 */
import { randomInt } from 'node:crypto';
import { POCKET_COUNT, isRouletteNumber } from '../../shared/roulette.js';
import type { OutcomeSource } from '../types.js';

export function createCryptoOutcomeSource(): OutcomeSource {
  return Object.freeze({
    kind: 'crypto' as const,
    next(): number {
      const n = randomInt(0, POCKET_COUNT);
      // Defensive: randomInt(0, 37) cannot return anything else; never pass on a bad outcome.
      if (!isRouletteNumber(n)) throw new Error(`Secure RNG returned an out-of-range outcome: ${String(n)}`);
      return n;
    },
  });
}
