/**
 * OWNER: rules agent. European roulette bet validation, coverage and settlement (pure, shared).
 * STUB — signatures are the contract; bodies are replaced by the owner.
 */
import type { BetInput, BetType, ResolvedBet, SessionLimits, Settlement, Subunits } from './contracts.js';

/** "X to 1" payout per bet type. */
export const PAYOUTS: Readonly<Record<BetType, number>> = {
  straight: 35, split: 17, street: 11, trio: 11, corner: 8, firstFour: 8, sixLine: 5,
  dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

/** Canonical key for a bet position (stake ignored), e.g. "split:0-3", "dozen:2", "red". */
export function betKey(bet: Omit<BetInput, 'stake'>): string {
  throw new Error('not implemented');
}

/** Validate ONE bet's shape + number combination (not balance/limits). Throws GameError('invalid_bet'). */
export function resolveBet(input: BetInput): ResolvedBet {
  throw new Error('not implemented');
}

/**
 * Validate a whole bet slip against the rules AND limits, backend-authoritative.
 * - rejects non-array / empty / > maxBetsPerRound (validation_error / limit_exceeded)
 * - every stake: safe integer, >= minStake, multiple of stakeIncrement, <= maxStakePerBet (invalid_bet / limit_exceeded)
 * - identical positions are merged by key (stakes summed) and re-checked against maxStakePerBet
 * - COMBINED stake <= maxStakePerRound (limit_exceeded) and <= balance (insufficient_funds)
 * Never "repairs" a bet into a different one.
 */
export function validateBetSlip(bets: unknown, ctx: { balance: Subunits; limits: SessionLimits }): ResolvedBet[] {
  throw new Error('not implemented');
}

/** Pure settlement. Integer math only. */
export function settleBets(bets: readonly ResolvedBet[], winningNumber: number): Settlement {
  throw new Error('not implemented');
}

/** Every legal bet position on the European layout (no stake), e.g. for UI hit-zones and exhaustive tests. */
export function allBetPositions(): Omit<BetInput, 'stake'>[] {
  throw new Error('not implemented');
}

/** Human label, e.g. "Corner 1/2/4/5", "2nd Dozen", "Red". */
export function describeBet(bet: Omit<BetInput, 'stake'>): string {
  throw new Error('not implemented');
}
