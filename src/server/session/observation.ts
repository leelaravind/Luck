/**
 * Builds the GameObservation — EVERYTHING a model (or the demo player) is allowed to know.
 *
 * Built only from the session's public state and SETTLED rounds. Each field is copied explicitly
 * (whitelist), so internal ids, RNG details, config, secrets and any pending/unsettled round can
 * never leak into a prompt by accident.
 */
import type {
  BetType,
  GameObservation,
  ObservedRound,
  RoundRecord,
  SessionInfo,
} from '../../shared/contracts.js';
import { PAYOUTS } from '../../shared/bets.js';
import { colorOf } from '../../shared/roulette.js';

/** Bet types that take explicit numbers / an index (everything else takes neither). */
const NUMBER_BETS: ReadonlySet<BetType> = new Set(['straight', 'split', 'street', 'trio', 'corner', 'firstFour', 'sixLine']);
const INDEX_BETS: ReadonlySet<BetType> = new Set(['dozen', 'column']);

/** How to express each bet type in a decision. Order = order shown to the model. */
export const BET_TYPE_SELECTION: readonly { type: BetType; selection: string }[] = [
  { type: 'straight', selection: 'numbers: [n], one number 0-36' },
  { type: 'split', selection: 'numbers: two adjacent numbers on the layout, e.g. [17,20] or [0,2]' },
  { type: 'street', selection: 'numbers: [n,n+1,n+2] with n in 1,4,7,...,34' },
  { type: 'trio', selection: 'numbers: [0,1,2] or [0,2,3]' },
  { type: 'corner', selection: 'numbers: four numbers forming a square, e.g. [1,2,4,5]' },
  { type: 'firstFour', selection: 'numbers: [0,1,2,3]' },
  { type: 'sixLine', selection: 'numbers: two adjacent streets, e.g. [1,2,3,4,5,6]' },
  { type: 'dozen', selection: 'index: 1 (1-12), 2 (13-24) or 3 (25-36)' },
  { type: 'column', selection: 'index: 1 (1,4,...,34), 2 (2,5,...,35) or 3 (3,6,...,36)' },
  { type: 'red', selection: 'no numbers or index' },
  { type: 'black', selection: 'no numbers or index' },
  { type: 'odd', selection: 'no numbers or index' },
  { type: 'even', selection: 'no numbers or index' },
  { type: 'low', selection: 'no numbers or index (covers 1-18)' },
  { type: 'high', selection: 'no numbers or index (covers 19-36)' },
];

export const OBSERVATION_RULES: readonly string[] = [
  'European single-zero roulette: 37 pockets, numbers 0-36; 0 is green, all other numbers are red or black.',
  'Virtual credits only; no real money is involved.',
  'Amounts are integer subunits: 100 subunits = 1 credit.',
  'Your bets are committed before the winning number is drawn by a secure random number generator.',
  'Outcomes are independent and cannot be predicted; past results do not influence future spins.',
  'A winning bet returns its stake plus stake x payout; a losing bet loses its stake.',
  'When 0 wins, every outside bet (red/black/odd/even/low/high/dozen/column) loses.',
  'Invalid decisions are rejected and never converted into a different bet.',
];

export const OBSERVATION_UNITS = 'credit subunits (100 = 1 virtual credit)';

/**
 * @param session  current session state
 * @param rounds   recent rounds of THIS session in any order/status; only settled ones are used
 */
export function buildObservation(session: SessionInfo, rounds: readonly RoundRecord[]): GameObservation {
  const limits = session.limits;
  const window = Math.max(0, Math.trunc(limits.historyWindow));

  const settled = rounds
    .filter((r) => r.sessionId === session.id && r.status === 'settled' && r.winningNumber !== null)
    .sort((a, b) => a.seq - b.seq);
  const recent = window === 0 ? [] : settled.slice(-window);

  return {
    schemaVersion: 1,
    game: 'european-roulette-single-zero',
    roundNumber: session.roundsPlayed + 1,
    balance: session.balance,
    units: OBSERVATION_UNITS,
    limits: {
      minStake: limits.minStake,
      stakeIncrement: limits.stakeIncrement,
      maxStakePerBet: limits.maxStakePerBet,
      maxStakePerRound: limits.maxStakePerRound,
      maxBetsPerRound: limits.maxBetsPerRound,
      roundsRemaining: limits.maxRounds === null ? null : Math.max(0, limits.maxRounds - session.roundsPlayed),
    },
    betTypes: BET_TYPE_SELECTION.map(({ type, selection }) => ({ type, payout: PAYOUTS[type], selection })),
    rules: [...OBSERVATION_RULES],
    history: recent.map(observeRound),
    stats: {
      roundsPlayed: session.roundsPlayed,
      netResult: session.balance - session.startingBalance,
    },
  };
}

function observeRound(r: RoundRecord): ObservedRound {
  const winningNumber = r.winningNumber as number;
  return {
    round: r.seq,
    winningNumber,
    color: colorOf(winningNumber),
    yourBets: r.bets.map((b) => {
      const bet: ObservedRound['yourBets'][number] = { type: b.type, stake: b.stake };
      if (NUMBER_BETS.has(b.type)) bet.numbers = [...b.numbers];
      if (INDEX_BETS.has(b.type) && b.index !== undefined) bet.index = b.index;
      return bet;
    }),
    yourTotalStake: r.totalStake,
    yourNet: r.net ?? 0,
  };
}
