/**
 * Rule-based demo player (not AI).
 *
 * A fixed, transparent rule so the app can be explored without any credentials:
 *   - flat stake of max(minStake, 1 credit rounded to the stake increment), clamped to the per-bet
 *     and per-round limits
 *   - one even-money bet per round, cycling red, black, odd, even, low, high by round number
 *   - skip the round when the balance cannot cover the stake
 * It has no predictive ability: every spin is independent and the rule cannot change the house edge.
 */
import type { BetType, GameObservation } from '../../shared/contracts.js';
import type { DemoPlayer } from '../types.js';
import { formatCredits } from '../../shared/money.js';

export const DEMO_PLAYER_LABEL = 'Rule-based demo player (not AI)';

/** Even-money bets in the order the demo player cycles through them. */
export const DEMO_BET_CYCLE: readonly BetType[] = ['red', 'black', 'odd', 'even', 'low', 'high'];

const BET_NAMES: Record<string, string> = {
  red: 'Red',
  black: 'Black',
  odd: 'Odd',
  even: 'Even',
  low: 'Low (1-18)',
  high: 'High (19-36)',
};

/** 1 credit = 100 subunits: the demo player's nominal flat stake. */
const NOMINAL_STAKE = 100;

/** Flat stake used by the demo player for the given limits (always a legal stake for valid limits). */
export function demoStake(limits: GameObservation['limits']): number {
  const inc = Math.max(1, limits.stakeIncrement);
  // 1 credit rounded to the increment (never below one increment).
  const rounded = Math.max(inc, Math.round(NOMINAL_STAKE / inc) * inc);
  let stake = Math.max(limits.minStake, rounded);
  // Clamp to the tighter of the per-bet / per-round caps, staying on the increment grid.
  const caps = [limits.maxStakePerBet, limits.maxStakePerRound].filter((v): v is number => v !== null);
  const cap = caps.length ? Math.floor(Math.min(...caps) / inc) * inc : Number.MAX_SAFE_INTEGER;
  if (stake > cap) stake = Math.max(limits.minStake, cap);
  return stake;
}

/** Bet type used for a (1-based) round number. */
export function demoBetType(roundNumber: number): BetType {
  const i = (((Math.max(1, Math.trunc(roundNumber)) - 1) % DEMO_BET_CYCLE.length) + DEMO_BET_CYCLE.length) % DEMO_BET_CYCLE.length;
  return DEMO_BET_CYCLE[i]!;
}

export function createDemoPlayer(): DemoPlayer {
  return {
    decide(obs) {
      const stake = demoStake(obs.limits);
      const type = demoBetType(obs.roundNumber);
      const rule =
        `${DEMO_PLAYER_LABEL}: flat ${formatCredits(stake)} on one even-money bet per round, ` +
        `cycling red, black, odd, even, low, high by round number.`;
      const honesty = 'The rule has no predictive ability; every spin is independent.';

      if (obs.balance < stake) {
        return {
          action: 'skip',
          explanation: `${rule} Balance ${formatCredits(obs.balance)} is below the flat stake, so this round is skipped. ${honesty}`,
        };
      }
      return {
        action: 'bet',
        bets: [{ type, stake }],
        explanation: `${rule} Round ${obs.roundNumber}: ${BET_NAMES[type] ?? type}. ${honesty}`,
      };
    },
  };
}
