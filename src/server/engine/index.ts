/**
 * OWNER: rules agent (A2). Engine entry point for production wiring.
 *
 * Exposes the secure outcome source and the (shared, pure) bet rules. The test-only fixture
 * source is deliberately NOT exported here; tests import './fixtureOutcome.js' explicitly.
 */
export { createCryptoOutcomeSource } from './rng.js';
export {
  PAYOUTS,
  allBetPositions,
  betKey,
  describeBet,
  resolveBet,
  settleBets,
  validateBetSlip,
} from '../../shared/bets.js';
