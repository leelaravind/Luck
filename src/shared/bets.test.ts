/**
 * Rules tests for src/shared/bets.ts.
 *
 * The expected coverage of every bet position is built HERE from first principles — a
 * hand-typed picture of the felt, explicit zero-bet lists and a hand-typed red-number list —
 * using geometric adjacency on that picture. It does not call the implementation's coverage
 * logic, so the exhaustive "157 positions × 37 outcomes" check is an independent oracle.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  GameError,
  type ApiErrorCode,
  type BetInput,
  type BetType,
  type ResolvedBet,
  type SessionLimits,
} from './contracts.js';
import { formatCredits, parseCredits } from './money.js';
import {
  PAYOUTS,
  allBetPositions,
  betKey,
  describeBet,
  resolveBet,
  settleBets,
  validateBetSlip,
} from './bets.js';

// ───────────────────────────── independent oracle ─────────────────────────────

/** The betting layout exactly as printed on the felt (top row first). Zero sits to the left of 3/2/1. */
const FELT: readonly (readonly number[])[] = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];

/** Standard European red numbers, typed by hand. */
const RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

/** Standard "X to 1" payouts, typed by hand (not imported from the implementation). */
const EXPECTED_PAYOUT: Record<BetType, number> = {
  straight: 35, split: 17, street: 11, trio: 11, corner: 8, firstFour: 8, sixLine: 5,
  dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

interface OraclePosition {
  /** What a player would submit (numbers in felt order, i.e. deliberately NOT sorted). */
  bet: Omit<BetInput, 'stake'>;
  /** Numbers this position wins on. */
  covers: ReadonlySet<number>;
  expectedKey: string;
}

const ONE_TO_36 = Array.from({ length: 36 }, (_, i) => i + 1);

function buildOracle(): OraclePosition[] {
  const out: OraclePosition[] = [];
  const inside = (type: BetType, numbers: number[]) =>
    out.push({
      bet: { type, numbers },
      covers: new Set(numbers),
      expectedKey: `${type}:${[...numbers].sort((a, b) => a - b).join('-')}`,
    });
  const outside = (bet: Omit<BetInput, 'stake'>, covers: number[], expectedKey: string) =>
    out.push({ bet, covers: new Set(covers), expectedKey });

  // Straight up: every pocket.
  for (let n = 0; n <= 36; n++) inside('straight', [n]);

  // Splits: cells that touch horizontally (same felt row) or vertically (same felt column), plus zero splits.
  for (let r = 0; r < 3; r++) for (let c = 0; c < 11; c++) inside('split', [FELT[r][c], FELT[r][c + 1]]);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 12; c++) inside('split', [FELT[r][c], FELT[r + 1][c]]);
  inside('split', [0, 1]);
  inside('split', [0, 2]);
  inside('split', [0, 3]);

  // Streets: one felt column (top to bottom, so input order is e.g. [3, 2, 1]).
  for (let c = 0; c < 12; c++) inside('street', [FELT[0][c], FELT[1][c], FELT[2][c]]);

  // Zero trios and first four.
  inside('trio', [0, 1, 2]);
  inside('trio', [0, 2, 3]);
  inside('firstFour', [0, 1, 2, 3]);

  // Corners: every 2×2 block of cells.
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 11; c++) {
      inside('corner', [FELT[r][c], FELT[r][c + 1], FELT[r + 1][c], FELT[r + 1][c + 1]]);
    }
  }

  // Six lines: two neighbouring felt columns.
  for (let c = 0; c < 11; c++) inside('sixLine', [0, 1, 2].flatMap((r) => [FELT[r][c], FELT[r][c + 1]]));

  // Dozens.
  outside({ type: 'dozen', index: 1 }, ONE_TO_36.filter((n) => n <= 12), 'dozen:1');
  outside({ type: 'dozen', index: 2 }, ONE_TO_36.filter((n) => n >= 13 && n <= 24), 'dozen:2');
  outside({ type: 'dozen', index: 3 }, ONE_TO_36.filter((n) => n >= 25), 'dozen:3');

  // Columns: column 1 is the bottom felt row (1, 4, …, 34), column 3 the top row (3, 6, …, 36).
  outside({ type: 'column', index: 1 }, [...FELT[2]], 'column:1');
  outside({ type: 'column', index: 2 }, [...FELT[1]], 'column:2');
  outside({ type: 'column', index: 3 }, [...FELT[0]], 'column:3');

  // Even money. Zero is in none of them.
  outside({ type: 'red' }, RED, 'red');
  outside({ type: 'black' }, ONE_TO_36.filter((n) => !RED.includes(n)), 'black');
  outside({ type: 'odd' }, ONE_TO_36.filter((n) => n % 2 === 1), 'odd');
  outside({ type: 'even' }, ONE_TO_36.filter((n) => n % 2 === 0), 'even');
  outside({ type: 'low' }, ONE_TO_36.filter((n) => n <= 18), 'low');
  outside({ type: 'high' }, ONE_TO_36.filter((n) => n >= 19), 'high');

  return out;
}

const ORACLE = buildOracle();
const OUTCOMES = Array.from({ length: 37 }, (_, i) => i);

function countByType(types: BetType[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

const EXPECTED_COUNTS = {
  straight: 37, split: 60, street: 12, trio: 2, corner: 22, firstFour: 1, sixLine: 11,
  dozen: 3, column: 3, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

// ───────────────────────────── helpers ─────────────────────────────

function expectGameError(fn: () => unknown, code: ApiErrorCode, message?: RegExp): GameError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a GameError to be thrown').toBeInstanceOf(GameError);
  const ge = caught as GameError;
  expect(ge.code).toBe(code);
  if (message) expect(ge.message).toMatch(message);
  return ge;
}

const LIMITS: SessionLimits = {
  ...DEFAULT_LIMITS,
  minStake: 10,
  stakeIncrement: 10,
  maxStakePerBet: 1000,
  maxStakePerRound: 2000,
  maxBetsPerRound: 5,
};
const CTX = { balance: 5000, limits: LIMITS };

const bet = (b: Omit<BetInput, 'stake'>, stake: number): BetInput => ({ ...b, stake });

// ───────────────────────────── oracle sanity ─────────────────────────────

describe('independent oracle (self-check)', () => {
  it('has 157 distinct positions with the documented per-type counts', () => {
    expect(ORACLE).toHaveLength(157);
    expect(new Set(ORACLE.map((p) => p.expectedKey)).size).toBe(157);
    expect(countByType(ORACLE.map((p) => p.bet.type))).toEqual(EXPECTED_COUNTS);
  });

  it('covers each number with the right number of inside positions', () => {
    // Sanity on the felt picture itself: 36 distinct numbers, 18 red, 18 black.
    expect(new Set(FELT.flat()).size).toBe(36);
    expect(RED).toHaveLength(18);
    // 5 (a middle-row cell) touches 4 split neighbours: 2, 4, 6, 8.
    const splitsOn5 = ORACLE.filter((p) => p.bet.type === 'split' && p.covers.has(5)).map((p) => p.expectedKey);
    expect(splitsOn5.sort()).toEqual(['split:2-5', 'split:4-5', 'split:5-6', 'split:5-8']);
  });
});

// ───────────────────────────── positions / keys / labels ─────────────────────────────

describe('allBetPositions', () => {
  it('returns exactly the 157 legal positions (same keys as the oracle)', () => {
    const positions = allBetPositions();
    expect(positions).toHaveLength(157);
    const keys = positions.map((p) => betKey(p));
    expect(new Set(keys).size).toBe(157);
    expect([...keys].sort()).toEqual(ORACLE.map((p) => p.expectedKey).sort());
    expect(countByType(positions.map((p) => p.type))).toEqual(EXPECTED_COUNTS);
  });

  it('every returned position resolves and has no stray fields', () => {
    for (const p of allBetPositions()) {
      expect(Object.keys(p).every((k) => k === 'type' || k === 'numbers' || k === 'index')).toBe(true);
      expect(() => resolveBet({ ...p, stake: 10 })).not.toThrow();
    }
  });

  it('returns fresh objects on every call', () => {
    const first = allBetPositions();
    first[0].numbers!.push(99);
    first[0].type = 'red';
    const second = allBetPositions();
    expect(second[0]).toEqual({ type: 'straight', numbers: [0] });
  });
});

describe('betKey', () => {
  it('is canonical and order-insensitive', () => {
    expect(betKey({ type: 'split', numbers: [3, 0] })).toBe('split:0-3');
    expect(betKey({ type: 'corner', numbers: [5, 4, 2, 1] })).toBe('corner:1-2-4-5');
    expect(betKey({ type: 'street', numbers: [9, 7, 8] })).toBe('street:7-8-9');
    expect(betKey({ type: 'firstFour', numbers: [3, 2, 1, 0] })).toBe('firstFour:0-1-2-3');
    expect(betKey({ type: 'straight', numbers: [17] })).toBe('straight:17');
    expect(betKey({ type: 'dozen', index: 2 })).toBe('dozen:2');
    expect(betKey({ type: 'column', index: 3 })).toBe('column:3');
    expect(betKey({ type: 'red' })).toBe('red');
    expect(betKey({ type: 'high' })).toBe('high');
  });

  it('refuses to key an illegal position', () => {
    expectGameError(() => betKey({ type: 'split', numbers: [3, 4] }), 'invalid_bet');
    expectGameError(() => betKey({ type: 'dozen', index: 4 }), 'invalid_bet');
  });
});

describe('describeBet', () => {
  it.each([
    [{ type: 'straight', numbers: [17] }, 'Straight 17'],
    [{ type: 'straight', numbers: [0] }, 'Straight 0'],
    [{ type: 'split', numbers: [3, 0] }, 'Split 0/3'],
    [{ type: 'split', numbers: [20, 17] }, 'Split 17/20'],
    [{ type: 'street', numbers: [9, 8, 7] }, 'Street 7-8-9'],
    [{ type: 'trio', numbers: [2, 1, 0] }, 'Trio 0/1/2'],
    [{ type: 'corner', numbers: [1, 2, 4, 5] }, 'Corner 1/2/4/5'],
    [{ type: 'firstFour', numbers: [0, 1, 2, 3] }, 'First four 0-1-2-3'],
    [{ type: 'sixLine', numbers: [1, 2, 3, 4, 5, 6] }, 'Six line 1-6'],
    [{ type: 'sixLine', numbers: [36, 35, 34, 33, 32, 31] }, 'Six line 31-36'],
    [{ type: 'dozen', index: 1 }, '1st Dozen (1-12)'],
    [{ type: 'dozen', index: 2 }, '2nd Dozen (13-24)'],
    [{ type: 'dozen', index: 3 }, '3rd Dozen (25-36)'],
    [{ type: 'column', index: 2 }, 'Column 2'],
    [{ type: 'red' }, 'Red'],
    [{ type: 'black' }, 'Black'],
    [{ type: 'odd' }, 'Odd'],
    [{ type: 'even' }, 'Even'],
    [{ type: 'low' }, 'Low (1-18)'],
    [{ type: 'high' }, 'High (19-36)'],
  ] as [Omit<BetInput, 'stake'>, string][])('%o → %s', (b, label) => {
    expect(describeBet(b)).toBe(label);
    expect(resolveBet({ ...b, stake: 10 }).label).toBe(label);
  });
});

// ───────────────────────────── exhaustive settlement ─────────────────────────────

describe('every legal position × all 37 outcomes (oracle)', () => {
  const STAKE = 130; // V$ 1.30 — not a round number, so payout arithmetic mistakes show up

  it.each(ORACLE.map((p): [string, OraclePosition] => [p.expectedKey, p]))('%s', (_key, pos) => {
    const resolved = resolveBet({ ...pos.bet, stake: STAKE });
    expect(resolved.key).toBe(pos.expectedKey);
    expect(resolved.type).toBe(pos.bet.type);
    expect(resolved.numbers).toEqual([...pos.covers].sort((a, b) => a - b));
    expect(resolved.payout).toBe(EXPECTED_PAYOUT[pos.bet.type]);
    expect(resolved.stake).toBe(STAKE);

    const payout = EXPECTED_PAYOUT[pos.bet.type];
    const mismatches: string[] = [];
    for (const n of OUTCOMES) {
      const s = settleBets([resolved], n);
      const won = pos.covers.has(n);
      const expected = {
        winningNumber: n,
        totalStake: STAKE,
        stakeReturned: won ? STAKE : 0,
        winnings: won ? STAKE * payout : 0,
        totalReturned: won ? STAKE * (payout + 1) : 0,
        net: won ? STAKE * payout : -STAKE,
        bets: [{ key: pos.expectedKey, won, returned: won ? STAKE * (payout + 1) : 0 }],
      };
      if (JSON.stringify(s) !== JSON.stringify(expected)) {
        mismatches.push(`outcome ${n}: got ${JSON.stringify(s)}, expected ${JSON.stringify(expected)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('checked 157 × 37 = 5809 (position, outcome) pairs', () => {
    expect(ORACLE.length * OUTCOMES.length).toBe(5809);
  });

  it('PAYOUTS export matches the standard table', () => {
    expect(PAYOUTS).toEqual(EXPECTED_PAYOUT);
  });
});

// ───────────────────────────── zero ─────────────────────────────

describe('zero', () => {
  it('straight 0 pays 35:1', () => {
    const s = settleBets([resolveBet({ type: 'straight', numbers: [0], stake: 100 })], 0);
    expect(s.bets[0]).toEqual({ key: 'straight:0', won: true, returned: 3600 });
    expect(s.winnings).toBe(3500);
    expect(s.net).toBe(3500);
  });

  it.each([
    { type: 'red' }, { type: 'black' }, { type: 'odd' }, { type: 'even' }, { type: 'low' }, { type: 'high' },
    { type: 'dozen', index: 1 }, { type: 'dozen', index: 2 }, { type: 'dozen', index: 3 },
    { type: 'column', index: 1 }, { type: 'column', index: 2 }, { type: 'column', index: 3 },
  ] as Omit<BetInput, 'stake'>[])('0 loses outside bet %o (no la partage / en prison)', (b) => {
    const s = settleBets([resolveBet({ ...b, stake: 100 })], 0);
    expect(s.bets[0].won).toBe(false);
    expect(s.bets[0].returned).toBe(0);
    expect(s.stakeReturned).toBe(0);
    expect(s.totalReturned).toBe(0);
    expect(s.net).toBe(-100);
  });

  it.each([
    [{ type: 'split', numbers: [0, 1] }, 1800],
    [{ type: 'split', numbers: [0, 2] }, 1800],
    [{ type: 'split', numbers: [3, 0] }, 1800],
    [{ type: 'trio', numbers: [0, 1, 2] }, 1200],
    [{ type: 'trio', numbers: [0, 2, 3] }, 1200],
    [{ type: 'firstFour', numbers: [0, 1, 2, 3] }, 900],
  ] as [Omit<BetInput, 'stake'>, number][])('%o pays on 0 (returns %i for stake 100)', (b, returned) => {
    const s = settleBets([resolveBet({ ...b, stake: 100 })], 0);
    expect(s.bets[0]).toMatchObject({ won: true, returned });
  });

  it('street 1-2-3, corner 1/2/4/5 and six line 1-6 do not cover 0', () => {
    const slip = [
      resolveBet({ type: 'street', numbers: [1, 2, 3], stake: 10 }),
      resolveBet({ type: 'corner', numbers: [1, 2, 4, 5], stake: 10 }),
      resolveBet({ type: 'sixLine', numbers: [1, 2, 3, 4, 5, 6], stake: 10 }),
    ];
    const s = settleBets(slip, 0);
    expect(s.bets.every((b) => !b.won)).toBe(true);
    expect(s.net).toBe(-30);
  });
});

// ───────────────────────────── multi-bet slips ─────────────────────────────

describe('multi-bet settlement', () => {
  const WIDE: SessionLimits = { ...LIMITS, maxBetsPerRound: 20, maxStakePerRound: 100_000 };

  it('overlapping winners on 17 sum correctly, losers in the same slip lose their stake', () => {
    const slip = validateBetSlip(
      [
        bet({ type: 'straight', numbers: [17] }, 10), //   returns  10×36 = 360
        bet({ type: 'split', numbers: [20, 17] }, 20), //  returns  20×18 = 360
        bet({ type: 'corner', numbers: [17, 16, 14, 13] }, 30), // 30×9 = 270
        bet({ type: 'street', numbers: [16, 17, 18] }, 40), //      40×12 = 480
        bet({ type: 'sixLine', numbers: [13, 14, 15, 16, 17, 18] }, 50), // 50×6 = 300
        bet({ type: 'column', index: 2 }, 60), //                   60×3 = 180
        bet({ type: 'dozen', index: 2 }, 70), //                    70×3 = 210
        bet({ type: 'black' }, 80), //                              80×2 = 160
        bet({ type: 'odd' }, 90), //                                90×2 = 180
        bet({ type: 'low' }, 100), //                              100×2 = 200
        bet({ type: 'red' }, 10), //   loses
        bet({ type: 'straight', numbers: [0] }, 10), // loses
        bet({ type: 'high' }, 10), //  loses
      ],
      { balance: 10_000, limits: WIDE },
    );
    const s = settleBets(slip, 17);
    expect(s.totalStake).toBe(580);
    expect(s.stakeReturned).toBe(550);
    expect(s.winnings).toBe(2150);
    expect(s.totalReturned).toBe(2700);
    expect(s.net).toBe(2120);
    expect(s.bets.map((b) => b.returned)).toEqual([360, 360, 270, 480, 300, 180, 210, 160, 180, 200, 0, 0, 0]);
    expect(s.bets.filter((b) => b.won)).toHaveLength(10);
  });

  it('mixed slip on 0: zero bets win, every outside bet and 1-2-3 street lose', () => {
    const slip = validateBetSlip(
      [
        bet({ type: 'straight', numbers: [0] }, 10), // 360
        bet({ type: 'split', numbers: [0, 2] }, 20), // 360
        bet({ type: 'trio', numbers: [0, 1, 2] }, 30), // 360
        bet({ type: 'firstFour', numbers: [0, 1, 2, 3] }, 40), // 360
        bet({ type: 'red' }, 50),
        bet({ type: 'even' }, 60),
        bet({ type: 'dozen', index: 1 }, 70),
        bet({ type: 'column', index: 1 }, 80),
        bet({ type: 'low' }, 90),
        bet({ type: 'street', numbers: [1, 2, 3] }, 100),
      ],
      { balance: 10_000, limits: WIDE },
    );
    const s = settleBets(slip, 0);
    expect(s.totalStake).toBe(550);
    expect(s.stakeReturned).toBe(100);
    expect(s.winnings).toBe(1340);
    expect(s.totalReturned).toBe(1440);
    expect(s.net).toBe(890);
  });

  it('a slip that loses everything has net = −totalStake', () => {
    const slip = [resolveBet({ type: 'red', stake: 100 }), resolveBet({ type: 'straight', numbers: [5], stake: 50 })];
    const s = settleBets(slip, 2); // 2 is black
    expect(s).toMatchObject({ totalStake: 150, stakeReturned: 0, winnings: 0, totalReturned: 0, net: -150 });
  });

  it('an even-money win returns the stake plus equal winnings (net = +stake)', () => {
    const s = settleBets([resolveBet({ type: 'red', stake: 250 })], 1);
    expect(s).toMatchObject({ stakeReturned: 250, winnings: 250, totalReturned: 500, net: 250 });
  });

  it('empty bet list settles to zeros', () => {
    expect(settleBets([], 5)).toEqual({
      winningNumber: 5, totalStake: 0, stakeReturned: 0, winnings: 0, totalReturned: 0, net: 0, bets: [],
    });
  });
});

// ───────────────────────────── integer / fractional-credit accounting ─────────────────────────────

describe('integer subunit accounting', () => {
  it('30 bets of 10 subunits (V$ 0.10) settle to exact integers', () => {
    const limits: SessionLimits = { ...LIMITS, maxBetsPerRound: 30 };
    const slip = validateBetSlip(
      Array.from({ length: 30 }, (_, i) => bet({ type: 'straight', numbers: [i + 1] }, 10)),
      { balance: 300, limits },
    );
    expect(slip.reduce((sum, b) => sum + b.stake, 0)).toBe(300);
    // In floating-point credits 0.1 × 30 accumulates error; in integer subunits it is exact.
    expect(Array.from({ length: 30 }, () => 0.1).reduce((a, b) => a + b, 0)).not.toBe(3);

    const win = settleBets(slip, 7);
    expect(win).toMatchObject({ totalStake: 300, stakeReturned: 10, winnings: 350, totalReturned: 360, net: 60 });
    expect(formatCredits(win.net, { sign: true })).toBe('+V$ 0.60');

    const lose = settleBets(slip, 0);
    expect(lose.net).toBe(-300);
    expect(formatCredits(lose.net)).toBe('−V$ 3.00');

    for (const n of OUTCOMES) {
      const s = settleBets(slip, n);
      for (const v of [s.totalStake, s.stakeReturned, s.winnings, s.totalReturned, s.net]) {
        expect(Number.isSafeInteger(v)).toBe(true);
      }
    }
  });

  it('a running balance over many rounds stays an exact integer', () => {
    let balance = 1_000_00;
    const slip = [
      resolveBet({ type: 'split', numbers: [8, 11], stake: 30 }),
      resolveBet({ type: 'dozen', index: 3, stake: 70 }),
      resolveBet({ type: 'odd', stake: 10 }),
    ];
    let expected = balance;
    for (let round = 0; round < 37 * 20; round++) {
      const n = round % 37;
      const s = settleBets(slip, n);
      balance = balance - s.totalStake + s.totalReturned;
      // Oracle for this slip, computed independently per outcome.
      const split = n === 8 || n === 11 ? 30 * 18 : 0;
      const dozen = n >= 25 ? 70 * 3 : 0;
      const odd = n !== 0 && n % 2 === 1 ? 10 * 2 : 0;
      expected = expected - 110 + split + dozen + odd;
      expect(balance).toBe(expected);
    }
    expect(Number.isSafeInteger(balance)).toBe(true);
  });

  it('parseCredits / formatCredits round-trip exactly', () => {
    const unformat = (s: string) => s.replace('V$ ', '').replaceAll(',', '');
    for (let v = 0; v <= 250_000; v += 7) {
      expect(parseCredits(unformat(formatCredits(v)))).toBe(v);
    }
    for (const v of [0, 1, 9, 10, 99, 100, 101, 12_345, 1_000_00, 123_456_789_01]) {
      expect(parseCredits(unformat(formatCredits(v)))).toBe(v);
    }
    expect(parseCredits('0.1')).toBe(10);
    expect(parseCredits('0.10')).toBe(10);
    expect(parseCredits('12.30')).toBe(1230);
    expect(parseCredits('1.005')).toBeNull();
    expect(parseCredits('-1')).toBeNull();
    expect(parseCredits('1e3')).toBeNull();
    expect(formatCredits(123_456)).toBe('V$ 1,234.56');
  });
});

// ───────────────────────────── invalid single bets ─────────────────────────────

describe('resolveBet rejects illegal bets (invalid_bet)', () => {
  it.each([
    [[3, 4]], [[4, 3]], [[1, 5]], [[0, 4]], [[6, 7]], [[12, 13]], [[1, 3]], [[1, 7]], [[0, 5]], [[33, 34]],
  ])('illegal split %o', (numbers) => {
    expectGameError(() => resolveBet({ type: 'split', numbers, stake: 10 }), 'invalid_bet', /not adjacent/);
  });

  it('names the numbers in the split error', () => {
    expectGameError(() => resolveBet({ type: 'split', numbers: [4, 3], stake: 10 }), 'invalid_bet', /Split 3\/4/);
  });

  it.each([[[35, 36]], [[33, 36]], [[1, 2]], [[2, 3]], [[0, 3]], [[34, 35]]])('legal split %o', (numbers) => {
    expect(resolveBet({ type: 'split', numbers, stake: 10 }).type).toBe('split');
  });

  it.each([[[3, 4, 6, 7]], [[1, 2, 3, 4]], [[0, 1, 2, 3]], [[1, 2, 5, 6]], [[6, 7, 9, 10]], [[1, 4, 7, 10]]])(
    'illegal corner %o',
    (numbers) => {
      expectGameError(() => resolveBet({ type: 'corner', numbers, stake: 10 }), 'invalid_bet', /square/);
    },
  );

  it.each([[[2, 3, 5, 6]], [[1, 2, 4, 5]], [[32, 33, 35, 36]], [[31, 32, 34, 35]]])('legal corner %o', (numbers) => {
    expect(resolveBet({ type: 'corner', numbers, stake: 10 }).key).toBe(`corner:${numbers.join('-')}`);
  });

  it('corner reaching past 36 is rejected as out of range', () => {
    expectGameError(() => resolveBet({ type: 'corner', numbers: [33, 34, 36, 37], stake: 10 }), 'invalid_bet', /37 is not a roulette number/);
  });

  it.each([[[2, 3, 4]], [[0, 1, 2]], [[3, 4, 5]], [[1, 2, 4]], [[1, 4, 7]]])('illegal street %o', (numbers) => {
    expectGameError(() => resolveBet({ type: 'street', numbers, stake: 10 }), 'invalid_bet', /not legal/);
  });

  it('street 34-35-36 is legal', () => {
    expect(resolveBet({ type: 'street', numbers: [34, 35, 36], stake: 10 }).label).toBe('Street 34-35-36');
  });

  it.each([[[1, 2, 3]], [[0, 1, 3]], [[0, 3, 6]]])('illegal trio %o', (numbers) => {
    expectGameError(() => resolveBet({ type: 'trio', numbers, stake: 10 }), 'invalid_bet', /trios are 0\/1\/2 and 0\/2\/3/);
  });

  it('illegal first four', () => {
    expectGameError(() => resolveBet({ type: 'firstFour', numbers: [0, 1, 2, 4], stake: 10 }), 'invalid_bet', /0-1-2-3/);
    expectGameError(() => resolveBet({ type: 'firstFour', stake: 10 }), 'invalid_bet', /needs "numbers"/);
  });

  it('six line 34-39 is rejected (out of range)', () => {
    expectGameError(
      () => resolveBet({ type: 'sixLine', numbers: [34, 35, 36, 37, 38, 39], stake: 10 }),
      'invalid_bet',
      /37 is not a roulette number/,
    );
  });

  it.each([[[2, 3, 4, 5, 6, 7]], [[1, 2, 3, 7, 8, 9]], [[0, 1, 2, 3, 4, 5]], [[3, 4, 5, 6, 7, 8]]])('illegal six line %o', (numbers) => {
    expectGameError(() => resolveBet({ type: 'sixLine', numbers, stake: 10 }), 'invalid_bet', /not legal/);
  });

  it('six line 31-36 is legal', () => {
    expect(resolveBet({ type: 'sixLine', numbers: [31, 32, 33, 34, 35, 36], stake: 10 }).key).toBe('sixLine:31-32-33-34-35-36');
  });

  it.each([0, 4, -1, 1.5, '1', null, Number.NaN])('dozen index %o is rejected', (index) => {
    expectGameError(() => resolveBet({ type: 'dozen', index: index as number, stake: 10 }), 'invalid_bet', /index/);
  });

  it.each([0, 4])('column index %o is rejected', (index) => {
    expectGameError(() => resolveBet({ type: 'column', index, stake: 10 }), 'invalid_bet', /must be 1, 2 or 3/);
  });

  it('dozen / column without index, or with numbers, are rejected', () => {
    expectGameError(() => resolveBet({ type: 'dozen', stake: 10 }), 'invalid_bet', /needs "index"/);
    expectGameError(() => resolveBet({ type: 'column', numbers: [1, 4], index: 1, stake: 10 }), 'invalid_bet', /must not have "numbers"/);
    expectGameError(() => resolveBet({ type: 'dozen', numbers: null as unknown as number[], index: 1, stake: 10 }), 'invalid_bet', /must not have "numbers"/);
  });

  it.each([37, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('straight on %o is rejected', (n) => {
    expectGameError(() => resolveBet({ type: 'straight', numbers: [n], stake: 10 }), 'invalid_bet', /not a roulette number/);
  });

  it('straight on the string "17" is rejected (no coercion)', () => {
    expectGameError(() => resolveBet({ type: 'straight', numbers: ['17' as unknown as number], stake: 10 }), 'invalid_bet', /"17" is not a roulette number/);
  });

  it('wrong number count / missing / non-array numbers', () => {
    expectGameError(() => resolveBet({ type: 'straight', numbers: [1, 2], stake: 10 }), 'invalid_bet', /exactly 1 number/);
    expectGameError(() => resolveBet({ type: 'split', numbers: [1], stake: 10 }), 'invalid_bet', /exactly 2 numbers/);
    expectGameError(() => resolveBet({ type: 'straight', stake: 10 }), 'invalid_bet', /needs "numbers"/);
    expectGameError(() => resolveBet({ type: 'straight', numbers: 17 as unknown as number[], stake: 10 }), 'invalid_bet', /must be an array/);
  });

  it('inside bet with an index is rejected', () => {
    expectGameError(() => resolveBet({ type: 'straight', numbers: [5], index: 1, stake: 10 }), 'invalid_bet', /must not have "index"/);
  });

  it('even-money bets with numbers or index are rejected', () => {
    expectGameError(() => resolveBet({ type: 'red', numbers: [1], stake: 10 }), 'invalid_bet', /must not have "numbers"/);
    expectGameError(() => resolveBet({ type: 'odd', index: 1, stake: 10 }), 'invalid_bet', /must not have "index"/);
  });

  it('duplicate numbers are rejected', () => {
    expectGameError(() => resolveBet({ type: 'split', numbers: [5, 5], stake: 10 }), 'invalid_bet', /5 appears more than once/);
    expectGameError(() => resolveBet({ type: 'corner', numbers: [1, 1, 2, 4], stake: 10 }), 'invalid_bet', /more than once/);
    expectGameError(() => resolveBet({ type: 'street', numbers: [1, 2, 2], stake: 10 }), 'invalid_bet', /more than once/);
  });

  it('unknown types and fields are rejected', () => {
    expectGameError(() => resolveBet({ type: 'basket' as BetType, numbers: [0, 1, 2], stake: 10 }), 'invalid_bet', /Unknown bet type "basket"/);
    expectGameError(() => resolveBet({ type: 'toString' as BetType, stake: 10 }), 'invalid_bet', /Unknown bet type/);
    expectGameError(() => resolveBet({ stake: 10 } as BetInput), 'invalid_bet', /missing "type"/);
    expectGameError(() => resolveBet({ type: 'red', stake: 10, colour: 'red' } as BetInput), 'invalid_bet', /unknown field "colour"/);
    expectGameError(() => resolveBet(null as unknown as BetInput), 'invalid_bet', /must be an object/);
  });

  it.each([10.5, -10, 0, Number.NaN, Number.POSITIVE_INFINITY, '10', undefined, null, 2 ** 53])('stake %o is rejected', (stake) => {
    expectGameError(() => resolveBet({ type: 'red', stake: stake as number }), 'invalid_bet', /stake must be a positive whole number/);
  });

  it('does not mutate the input', () => {
    const input = { type: 'corner' as const, numbers: [5, 4, 2, 1], stake: 10 };
    const resolved = resolveBet(input);
    expect(input.numbers).toEqual([5, 4, 2, 1]);
    expect(resolved.numbers).toEqual([1, 2, 4, 5]);
    expect(resolved).toEqual({ key: 'corner:1-2-4-5', type: 'corner', numbers: [1, 2, 4, 5], stake: 10, payout: 8, label: 'Corner 1/2/4/5' });
  });

  it('dozen / column carry index; resolved outside bets list covered numbers', () => {
    expect(resolveBet({ type: 'dozen', index: 3, stake: 10 })).toMatchObject({ index: 3, numbers: ONE_TO_36.slice(24) });
    expect('index' in resolveBet({ type: 'red', stake: 10 })).toBe(false);
  });
});

// ───────────────────────────── bet slip validation ─────────────────────────────

describe('validateBetSlip', () => {
  it('accepts a valid slip and returns resolved bets', () => {
    const out = validateBetSlip([bet({ type: 'red' }, 100), bet({ type: 'straight', numbers: [17] }, 50)], CTX);
    expect(out.map((b) => [b.key, b.stake])).toEqual([['red', 100], ['straight:17', 50]]);
  });

  it.each([{}, null, 'bets', 5, undefined])('non-array %o → validation_error', (bets) => {
    expectGameError(() => validateBetSlip(bets, CTX), 'validation_error', /must be an array/);
  });

  it('empty slip → validation_error', () => {
    expectGameError(() => validateBetSlip([], CTX), 'validation_error', /empty/);
  });

  it.each([null, 'red', 5, [1, 2]])('non-object entry %o → validation_error', (entry) => {
    const ge = expectGameError(() => validateBetSlip([bet({ type: 'red' }, 10), entry], CTX), 'validation_error', /Bet 2 must be an object/);
    expect(ge.details).toEqual({ betIndex: 1 });
  });

  it('illegal bet inside a slip → invalid_bet with position', () => {
    const ge = expectGameError(
      () => validateBetSlip([bet({ type: 'red' }, 10), bet({ type: 'split', numbers: [3, 4] }, 10)], CTX),
      'invalid_bet',
      /^Bet 2: Split 3\/4 is not legal/,
    );
    expect(ge.details).toEqual({ betIndex: 1 });
  });

  it('never repairs an illegal bet into a neighbouring legal one', () => {
    expectGameError(() => validateBetSlip([bet({ type: 'corner', numbers: [3, 4, 6, 7] }, 10)], CTX), 'invalid_bet');
    expectGameError(() => validateBetSlip([bet({ type: 'street', numbers: [2, 3, 4] }, 10)], CTX), 'invalid_bet');
  });

  it(`more than maxBetsPerRound (${LIMITS.maxBetsPerRound}) → limit_exceeded; exactly the limit is fine`, () => {
    const five = [1, 2, 3, 4, 5].map((n) => bet({ type: 'straight', numbers: [n] }, 10));
    expect(validateBetSlip(five, CTX)).toHaveLength(5);
    expectGameError(() => validateBetSlip([...five, bet({ type: 'red' }, 10)], CTX), 'limit_exceeded', /Too many bets: 6/);
  });

  it.each([10.5, -10, 0, Number.NaN, Number.POSITIVE_INFINITY, '10', 2 ** 53])('stake %o → invalid_bet', (stake) => {
    expectGameError(() => validateBetSlip([{ type: 'red', stake }], CTX), 'invalid_bet', /stake must be a positive whole number/);
  });

  it('stake that is not a multiple of stakeIncrement → invalid_bet', () => {
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 15)], CTX), 'invalid_bet', /not a multiple of the stake increment/);
    const limits = { ...LIMITS, minStake: 50, stakeIncrement: 50 };
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 120)], { balance: 5000, limits }), 'invalid_bet', /not a multiple/);
    expect(validateBetSlip([bet({ type: 'red' }, 150)], { balance: 5000, limits })[0].stake).toBe(150);
  });

  it('stake below minStake → invalid_bet', () => {
    const limits = { ...LIMITS, minStake: 20 };
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 10)], { balance: 5000, limits }), 'invalid_bet', /below the minimum stake/);
  });

  it('stake above maxStakePerBet → limit_exceeded', () => {
    expect(validateBetSlip([bet({ type: 'red' }, 1000)], CTX)[0].stake).toBe(1000);
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 1010)], CTX), 'limit_exceeded', /maximum stake per bet/);
  });

  it('identical positions are merged by key and re-checked against maxStakePerBet', () => {
    // 600 + 500 on the same number: each alone is fine, together 1100 > 1000.
    expectGameError(
      () => validateBetSlip([bet({ type: 'straight', numbers: [17] }, 600), bet({ type: 'straight', numbers: [17] }, 500)], CTX),
      'limit_exceeded',
      /combined stake on Straight 17 would be V\$ 11\.00/,
    );
    // Same split written in a different order is the same position.
    expectGameError(
      () => validateBetSlip([bet({ type: 'split', numbers: [1, 2] }, 600), bet({ type: 'split', numbers: [2, 1] }, 500)], CTX),
      'limit_exceeded',
    );
    const merged = validateBetSlip(
      [
        bet({ type: 'split', numbers: [1, 2] }, 300),
        bet({ type: 'red' }, 100),
        bet({ type: 'split', numbers: [2, 1] }, 200),
      ],
      CTX,
    );
    expect(merged.map((b) => [b.key, b.stake])).toEqual([['split:1-2', 500], ['red', 100]]);
  });

  it('combined stake above maxStakePerRound → limit_exceeded', () => {
    const slip = [bet({ type: 'red' }, 1000), bet({ type: 'black' }, 1000), bet({ type: 'odd' }, 10)];
    expectGameError(() => validateBetSlip(slip, CTX), 'limit_exceeded', /maximum stake per round/);
    expect(validateBetSlip(slip.slice(0, 2), CTX)).toHaveLength(2); // exactly 2000 is allowed
  });

  it('combined stake above the balance → insufficient_funds (even when each bet alone fits)', () => {
    const slip = [bet({ type: 'red' }, 100), bet({ type: 'black' }, 100)];
    expectGameError(() => validateBetSlip(slip, { balance: 150, limits: LIMITS }), 'insufficient_funds', /exceeds the balance/);
    expect(validateBetSlip(slip, { balance: 200, limits: LIMITS })).toHaveLength(2); // exactly the balance is allowed
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 10)], { balance: 0, limits: LIMITS }), 'insufficient_funds');
  });

  it('refuses a slip whose best possible return plus the remaining balance would exceed the safe integer range', () => {
    const open: SessionLimits = { ...DEFAULT_LIMITS, minStake: 10, stakeIncrement: 10, maxStakePerBet: null, maxStakePerRound: null, maxBetsPerRound: null };
    // Balance ~9e15 (the audit's 1e11 start after three all-in straight-up wins is ~4.7e15).
    const balance = 9_000_000_000_000_000 - (9_000_000_000_000_000 % 10);
    expect(Number.isSafeInteger(balance)).toBe(true);
    // All-in on red: a win would return 2 × balance > MAX_SAFE_INTEGER.
    const ge = expectGameError(() => validateBetSlip([{ type: 'red', stake: balance }], { balance, limits: open }), 'limit_exceeded', /could return up to .* would exceed the largest balance/);
    expect(ge.details).toMatchObject({ actual: balance * 2 });
    // A straight-up bet much smaller than the balance can still overflow: 36 × stake + (balance − stake).
    const stake = 100_000_000_000_000; // 36 × 1e14 = 3.6e15 on top of ~8.9e15 remaining
    expectGameError(() => validateBetSlip([{ type: 'straight', numbers: [7], stake }], { balance, limits: open }), 'limit_exceeded', /Lower the stakes/);
    // The best single number counts, not the sum of all bets: red + black never both win.
    const half = 1_000_000_000_000_000;
    expect(validateBetSlip([{ type: 'red', stake: half }, { type: 'black', stake: half }], { balance: 4 * half, limits: open })).toHaveLength(2);
    // Exactly at the limit is fine: (balance − stake) + 2 × stake === MAX_SAFE_INTEGER.
    const exact = { balance: 6_000_000_000_000_000, limits: { ...open, minStake: 1, stakeIncrement: 1 } };
    const atLimit = Number.MAX_SAFE_INTEGER - exact.balance; // 3 007 199 254 740 991
    expect(validateBetSlip([{ type: 'even', stake: atLimit }], exact)).toHaveLength(1);
    expectGameError(() => validateBetSlip([{ type: 'even', stake: atLimit + 1 }], exact), 'limit_exceeded');
  });

  it('refuses to run with nonsensical limits', () => {
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 10)], { balance: 100, limits: { ...LIMITS, stakeIncrement: 0 } }), 'internal');
    expectGameError(() => validateBetSlip([bet({ type: 'red' }, 10)], { balance: 1.5, limits: LIMITS }), 'internal');
  });
});

// ───────────────────────────── settlement input guards ─────────────────────────────

describe('settleBets guards', () => {
  const red = (): ResolvedBet => resolveBet({ type: 'red', stake: 100 });

  it.each([37, -1, 1.5, Number.NaN])('rejects winning number %o', (n) => {
    expectGameError(() => settleBets([red()], n), 'internal', /not a roulette number/);
  });

  it('rejects a tampered payout, key or stake', () => {
    expectGameError(() => settleBets([{ ...red(), payout: 2 }], 1), 'internal', /payout/);
    expectGameError(() => settleBets([{ ...red(), key: 'black' }], 1), 'internal', /key/);
    expectGameError(() => settleBets([{ ...red(), stake: 10.5 }], 1), 'internal', /stake/);
    const straight = resolveBet({ type: 'straight', numbers: [17], stake: 10 });
    expectGameError(() => settleBets([{ ...straight, numbers: [18] }], 18), 'internal', /key/);
    expectGameError(() => settleBets([{ ...straight, type: 'basket' as BetType }], 17), 'internal', /corrupt/);
  });

  it('derives coverage from the position, not from a stored numbers list', () => {
    // A red bet whose stored numbers were corrupted to include 0 still loses on 0.
    const s = settleBets([{ ...red(), numbers: [0] }], 0);
    expect(s.bets[0].won).toBe(false);
  });

  it('does not mutate the bets it settles', () => {
    const slip = [red(), resolveBet({ type: 'straight', numbers: [1], stake: 10 })];
    const copy = structuredClone(slip);
    settleBets(slip, 1);
    expect(slip).toEqual(copy);
  });
});
