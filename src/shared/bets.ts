/**
 * OWNER: rules agent (A2). European single-zero roulette: bet positions, validation, settlement
 * and labels. Pure and shared — the backend uses it authoritatively, the UI only for display
 * (hit-zones, labels). Nothing here draws random numbers or touches balances.
 *
 * House rules implemented here:
 *  - European single zero, standard "X to 1" payouts (see PAYOUTS).
 *  - ZERO LOSES EVERY OUTSIDE BET (dozens, columns, red/black, odd/even, low/high).
 *    There is no "la partage" (half stake back) and no "en prison" rule.
 *  - Zero is covered only by: straight 0, the zero splits 0/1, 0/2, 0/3, the trios 0/1/2 and
 *    0/2/3, and the first four 0/1/2/3.
 *  - Money is integer subunits (100 = 1 credit). Settlement uses integer math only.
 *  - Bets are validated exactly as submitted and are never "repaired" into a different bet.
 *
 * Layout reference (numbers 1..36 in 12 layout columns of 3; 0 sits beside 1, 2 and 3):
 *
 *        3  6  9 12 15 18 21 24 27 30 33 36   ← "Column 3" bet (n % 3 === 0)
 *    0   2  5  8 11 14 17 20 23 26 29 32 35   ← "Column 2" bet (n % 3 === 2)
 *        1  4  7 10 13 16 19 22 25 28 31 34   ← "Column 1" bet (n % 3 === 1)
 *
 *  - n and n+3 are neighbours in the same row (split).
 *  - n and n+1 are neighbours in the same layout column unless n % 3 === 0 (3/4 is NOT a split).
 *  - A street is one layout column: n, n+1, n+2 with n % 3 === 1.
 *  - A corner is a 2×2 square: n, n+1, n+3, n+4 with n % 3 !== 0 and n <= 32.
 *  - A six line is two adjacent streets: n..n+5 with n % 3 === 1 and n <= 31.
 */
import {
  GameError,
  type BetInput,
  type BetType,
  type ResolvedBet,
  type SessionLimits,
  type Settlement,
  type Subunits,
} from './contracts.js';
import { formatCredits } from './money.js';
import { RED_NUMBERS, isRouletteNumber } from './roulette.js';

/** "X to 1" payout per bet type. */
export const PAYOUTS: Readonly<Record<BetType, number>> = {
  straight: 35, split: 17, street: 11, trio: 11, corner: 8, firstFour: 8, sixLine: 5,
  dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

// ───────────────────────────── bet type metadata ─────────────────────────────

/** How many numbers each inside bet takes (inside bets are identified by `numbers`). */
const INSIDE_SIZE: Readonly<Partial<Record<BetType, number>>> = {
  straight: 1, split: 2, street: 3, trio: 3, corner: 4, firstFour: 4, sixLine: 6,
};

/** Bets identified by `index` (1, 2 or 3). */
const INDEXED_TYPES: ReadonlySet<BetType> = new Set<BetType>(['dozen', 'column']);

/** Even-money bets carry neither `numbers` nor `index`. */
const EVEN_MONEY_TYPES: readonly BetType[] = ['red', 'black', 'odd', 'even', 'low', 'high'];

const TYPE_NAME: Readonly<Record<BetType, string>> = {
  straight: 'Straight', split: 'Split', street: 'Street', trio: 'Trio', corner: 'Corner',
  firstFour: 'First four', sixLine: 'Six line', dozen: 'Dozen', column: 'Column',
  red: 'Red', black: 'Black', odd: 'Odd', even: 'Even', low: 'Low (1-18)', high: 'High (19-36)',
};

const ALL_TYPES = Object.keys(PAYOUTS) as BetType[];

/** Fields a submitted BetInput may carry. Anything else is rejected, never ignored. */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['type', 'numbers', 'index', 'stake']);

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Numbers covered by each outside bet (zero is in none of them). */
const EVEN_MONEY_COVERAGE: Readonly<Record<string, readonly number[]>> = {
  red: range(1, 36).filter((n) => RED_NUMBERS.has(n)),
  black: range(1, 36).filter((n) => !RED_NUMBERS.has(n)),
  odd: range(1, 36).filter((n) => n % 2 === 1),
  even: range(1, 36).filter((n) => n % 2 === 0),
  low: range(1, 18),
  high: range(19, 36),
};

function dozenCoverage(index: number): number[] {
  return range(12 * (index - 1) + 1, 12 * index);
}

/** Column bet i covers the layout row whose numbers satisfy ((n - 1) % 3) + 1 === i. */
function columnCoverage(index: number): number[] {
  return range(1, 36).filter((n) => ((n - 1) % 3) + 1 === index);
}

const ORDINAL = ['', '1st', '2nd', '3rd'];

// ───────────────────────────── position resolution ─────────────────────────────

/** A validated bet position (no stake). */
interface Position {
  key: string;
  type: BetType;
  /** Covered numbers, sorted ascending. */
  numbers: number[];
  index?: number;
  label: string;
}

function invalid(message: string): never {
  throw new GameError('invalid_bet', message);
}

/** Short printable form of an untrusted value for error messages. */
function show(value: unknown): string {
  let s: string;
  if (typeof value === 'string') s = JSON.stringify(value);
  else if (typeof value === 'number' || typeof value === 'boolean' || value == null) s = String(value);
  else if (Array.isArray(value)) s = `array(${value.length})`;
  else s = typeof value;
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate the `numbers` array of an inside bet: exact count, integers 0-36, no duplicates. Returns a sorted copy. */
function readNumbers(type: BetType, raw: unknown, size: number): number[] {
  const name = TYPE_NAME[type];
  const want = `${size} number${size === 1 ? '' : 's'}`;
  if (raw === undefined) invalid(`${name} bet needs "numbers" (${want})`);
  if (!Array.isArray(raw)) invalid(`${name} bet "numbers" must be an array of ${want}, got ${show(raw)}`);
  if (raw.length !== size) invalid(`${name} bet takes exactly ${want}, got ${raw.length}`);
  for (const v of raw) {
    if (!isRouletteNumber(v)) invalid(`${name} bet: ${show(v)} is not a roulette number (whole numbers 0-36)`);
  }
  const sorted = [...(raw as number[])].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) invalid(`${name} bet: number ${sorted[i]} appears more than once`);
  }
  return sorted;
}

/** Check that sorted numbers form a legal combination for the inside bet type. */
function checkCombination(type: BetType, s: number[]): void {
  const [a] = s;
  switch (type) {
    case 'straight':
      return;
    case 'split': {
      const b = s[1];
      // Zero splits 0/1, 0/2, 0/3; otherwise same row (n, n+3) or same layout column (n, n+1 with n % 3 !== 0).
      const legal = a === 0 ? b <= 3 : b - a === 3 || (b - a === 1 && a % 3 !== 0);
      if (!legal) invalid(`Split ${a}/${b} is not legal: ${a} and ${b} are not adjacent on the layout`);
      return;
    }
    case 'street': {
      const legal = a % 3 === 1 && s[1] === a + 1 && s[2] === a + 2;
      if (!legal) {
        invalid(`Street ${s.join('-')} is not legal: a street is n, n+1, n+2 starting at 1, 4, 7, ... 34`);
      }
      return;
    }
    case 'trio': {
      const k = s.join('-');
      if (k !== '0-1-2' && k !== '0-2-3') invalid(`Trio ${s.join('/')} is not legal: the trios are 0/1/2 and 0/2/3`);
      return;
    }
    case 'corner': {
      const legal = a >= 1 && a % 3 !== 0 && s[1] === a + 1 && s[2] === a + 3 && s[3] === a + 4;
      if (!legal) invalid(`Corner ${s.join('/')} is not legal: the four numbers must form a square on the layout`);
      return;
    }
    case 'firstFour':
      if (s.join('-') !== '0-1-2-3') invalid(`First four must be exactly 0-1-2-3, got ${s.join('-')}`);
      return;
    case 'sixLine': {
      const legal = a % 3 === 1 && s.every((n, i) => n === a + i);
      if (!legal) {
        invalid(`Six line ${s.join('-')} is not legal: a six line is two adjacent streets n..n+5 starting at 1, 4, ... 31`);
      }
      return;
    }
    default:
      invalid(`${TYPE_NAME[type]} is not an inside bet`);
  }
}

function insideLabel(type: BetType, s: number[]): string {
  switch (type) {
    case 'straight':
      return `Straight ${s[0]}`;
    case 'split':
    case 'trio':
    case 'corner':
      return `${TYPE_NAME[type]} ${s.join('/')}`;
    case 'street':
    case 'firstFour':
      return `${TYPE_NAME[type]} ${s.join('-')}`;
    case 'sixLine':
      return `Six line ${s[0]}-${s[s.length - 1]}`;
    default:
      return TYPE_NAME[type];
  }
}

/**
 * Validate a bet POSITION (type + numbers/index; stake and unknown fields are not looked at)
 * and derive its canonical key, covered numbers and label. Throws GameError('invalid_bet').
 * `undefined` counts as "field absent"; any other value (including null) counts as present.
 */
function resolvePosition(input: { type?: unknown; numbers?: unknown; index?: unknown }): Position {
  const type = input.type;
  if (type === undefined) invalid('Bet is missing "type"');
  if (typeof type !== 'string' || !Object.hasOwn(PAYOUTS, type)) {
    invalid(`Unknown bet type ${show(type)}; expected one of: ${ALL_TYPES.join(', ')}`);
  }
  const t = type as BetType;
  const name = TYPE_NAME[t];

  const size = INSIDE_SIZE[t];
  if (size !== undefined) {
    if (input.index !== undefined) invalid(`${name} bet must not have "index" (it is identified by "numbers")`);
    const s = readNumbers(t, input.numbers, size);
    checkCombination(t, s);
    return { key: `${t}:${s.join('-')}`, type: t, numbers: s, label: insideLabel(t, s) };
  }

  if (INDEXED_TYPES.has(t)) {
    if (input.numbers !== undefined) invalid(`${name} bet must not have "numbers"; use "index" (1, 2 or 3)`);
    const i = input.index;
    if (i === undefined) invalid(`${name} bet needs "index" (1, 2 or 3)`);
    if (i !== 1 && i !== 2 && i !== 3) invalid(`${name} bet "index" must be 1, 2 or 3, got ${show(i)}`);
    if (t === 'dozen') {
      const numbers = dozenCoverage(i);
      const label = `${ORDINAL[i]} Dozen (${numbers[0]}-${numbers[numbers.length - 1]})`;
      return { key: `dozen:${i}`, type: t, numbers, index: i, label };
    }
    return { key: `column:${i}`, type: t, numbers: columnCoverage(i), index: i, label: `Column ${i}` };
  }

  // Even-money bets.
  if (input.numbers !== undefined) invalid(`${name} bet must not have "numbers"`);
  if (input.index !== undefined) invalid(`${name} bet must not have "index"`);
  return { key: t, type: t, numbers: [...EVEN_MONEY_COVERAGE[t]], label: name };
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Canonical key for a bet position (stake ignored), e.g. "split:0-3", "dozen:2", "red".
 * Order-insensitive for numbers. Throws GameError('invalid_bet') for an illegal position, so a
 * key always names a real position on the layout.
 */
export function betKey(bet: Omit<BetInput, 'stake'>): string {
  return resolvePosition(bet).key;
}

/** Validate ONE bet's shape + number combination (not balance/limits). Throws GameError('invalid_bet'). */
export function resolveBet(input: BetInput): ResolvedBet {
  if (!isPlainObject(input)) invalid(`Bet must be an object, got ${show(input)}`);
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) invalid(`Bet has unknown field ${show(field)} (allowed: type, numbers, index, stake)`);
  }
  const pos = resolvePosition(input);
  const stake: unknown = input.stake;
  if (typeof stake !== 'number' || !Number.isSafeInteger(stake) || stake <= 0) {
    invalid(`${pos.label}: stake must be a positive whole number of subunits, got ${show(stake)}`);
  }
  const bet: ResolvedBet = {
    key: pos.key,
    type: pos.type,
    numbers: pos.numbers,
    stake,
    payout: PAYOUTS[pos.type],
    label: pos.label,
  };
  if (pos.index !== undefined) bet.index = pos.index;
  return bet;
}

/** "V$ 0.15 (15 subunits)" — readable amounts in error messages. */
function amount(n: Subunits): string {
  return `${formatCredits(n)} (${n} subunits)`;
}

function assertLimits(balance: Subunits, limits: SessionLimits): void {
  const positiveInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const ok =
    Number.isSafeInteger(balance) &&
    positiveInt(limits.minStake) &&
    positiveInt(limits.stakeIncrement) &&
    positiveInt(limits.maxStakePerBet) &&
    positiveInt(limits.maxStakePerRound) &&
    positiveInt(limits.maxBetsPerRound);
  if (!ok) throw new GameError('internal', 'Bet validation called with an invalid balance or session limits');
}

/**
 * Validate a whole bet slip against the rules AND limits, backend-authoritative.
 * - rejects non-array / empty / > maxBetsPerRound (validation_error / limit_exceeded)
 * - every stake: safe integer, >= minStake, multiple of stakeIncrement, <= maxStakePerBet (invalid_bet / limit_exceeded)
 * - identical positions are merged by key (stakes summed) and re-checked against maxStakePerBet
 * - COMBINED stake <= maxStakePerRound (limit_exceeded) and <= balance (insufficient_funds)
 * Never "repairs" a bet into a different one.
 *
 * Notes: maxBetsPerRound is checked against the number of SUBMITTED entries (before merging).
 * Errors about one bet are prefixed "Bet <n>:" (1-based) and carry details { betIndex } (0-based).
 * Returns the merged bets in order of first appearance.
 */
export function validateBetSlip(bets: unknown, ctx: { balance: Subunits; limits: SessionLimits }): ResolvedBet[] {
  const { balance, limits } = ctx;
  assertLimits(balance, limits);

  if (!Array.isArray(bets)) throw new GameError('validation_error', `Bets must be an array, got ${show(bets)}`);
  if (bets.length === 0) throw new GameError('validation_error', 'Bet slip is empty: place at least one bet');
  if (bets.length > limits.maxBetsPerRound) {
    throw new GameError(
      'limit_exceeded',
      `Too many bets: ${bets.length} submitted, the limit is ${limits.maxBetsPerRound} per round`,
      { limit: limits.maxBetsPerRound, actual: bets.length },
    );
  }

  const merged = new Map<string, ResolvedBet>();
  bets.forEach((raw: unknown, i) => {
    const where = `Bet ${i + 1}`;
    if (!isPlainObject(raw)) {
      throw new GameError('validation_error', `${where} must be an object, got ${show(raw)}`, { betIndex: i });
    }
    let bet: ResolvedBet;
    try {
      bet = resolveBet(raw as unknown as BetInput);
    } catch (err) {
      if (err instanceof GameError) throw new GameError(err.code, `${where}: ${err.message}`, { betIndex: i });
      throw err;
    }
    const what = `${where} (${bet.label})`;
    if (bet.stake < limits.minStake) {
      throw new GameError('invalid_bet', `${what}: stake ${amount(bet.stake)} is below the minimum stake of ${amount(limits.minStake)}`, { betIndex: i });
    }
    if (bet.stake % limits.stakeIncrement !== 0) {
      throw new GameError('invalid_bet', `${what}: stake ${amount(bet.stake)} is not a multiple of the stake increment ${amount(limits.stakeIncrement)}`, { betIndex: i });
    }
    if (bet.stake > limits.maxStakePerBet) {
      throw new GameError('limit_exceeded', `${what}: stake ${amount(bet.stake)} exceeds the maximum stake per bet of ${amount(limits.maxStakePerBet)}`, { betIndex: i, limit: limits.maxStakePerBet, actual: bet.stake });
    }
    const existing = merged.get(bet.key);
    if (!existing) {
      merged.set(bet.key, bet);
      return;
    }
    const combined = existing.stake + bet.stake;
    if (combined > limits.maxStakePerBet) {
      throw new GameError('limit_exceeded', `${what}: combined stake on ${bet.label} would be ${amount(combined)}, above the maximum stake per bet of ${amount(limits.maxStakePerBet)}`, { betIndex: i, limit: limits.maxStakePerBet, actual: combined });
    }
    existing.stake = combined;
  });

  const result = [...merged.values()];
  // Every stake is <= maxStakePerBet (a safe integer) and there are at most maxBetsPerRound of them,
  // so this sum stays far inside the safe-integer range for any sane limits; checked anyway.
  const total = result.reduce((sum, b) => sum + b.stake, 0);
  if (!Number.isSafeInteger(total)) throw new GameError('limit_exceeded', 'Combined stake is too large');
  if (total > limits.maxStakePerRound) {
    throw new GameError('limit_exceeded', `Combined stake ${amount(total)} exceeds the maximum stake per round of ${amount(limits.maxStakePerRound)}`, { limit: limits.maxStakePerRound, actual: total });
  }
  if (total > balance) {
    throw new GameError('insufficient_funds', `Combined stake ${amount(total)} exceeds the balance of ${amount(balance)}`, { balance, actual: total });
  }
  return result;
}

/**
 * Pure settlement. Integer math only.
 * A winning bet returns stake × (payout + 1): its stake back plus stake × payout winnings.
 * A losing bet returns 0. Zero loses all outside bets (no la partage / en prison).
 *
 * Coverage is re-derived from each bet's canonical position (type + numbers/index), not trusted
 * from bet.numbers; a bet whose key, payout or stake is inconsistent throws GameError('internal').
 */
export function settleBets(bets: readonly ResolvedBet[], winningNumber: number): Settlement {
  if (!isRouletteNumber(winningNumber)) {
    throw new GameError('internal', `Cannot settle: ${show(winningNumber)} is not a roulette number`);
  }
  let totalStake = 0;
  let stakeReturned = 0;
  let winnings = 0;
  const settled: Settlement['bets'] = [];

  for (const bet of bets) {
    let pos: Position;
    try {
      const inside = typeof bet.type === 'string' && INSIDE_SIZE[bet.type] !== undefined;
      pos = resolvePosition({
        type: bet.type,
        numbers: inside ? bet.numbers : undefined,
        index: INDEXED_TYPES.has(bet.type) ? bet.index : undefined,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new GameError('internal', `Cannot settle corrupt bet ${show(bet.key)}: ${why}`);
    }
    if (pos.key !== bet.key) throw new GameError('internal', `Cannot settle bet ${show(bet.key)}: key does not match its position ${pos.key}`);
    const payout = PAYOUTS[pos.type];
    if (bet.payout !== payout) throw new GameError('internal', `Cannot settle bet ${pos.key}: payout ${show(bet.payout)} should be ${payout}`);
    if (!Number.isSafeInteger(bet.stake) || bet.stake <= 0) {
      throw new GameError('internal', `Cannot settle bet ${pos.key}: stake ${show(bet.stake)} is not a positive integer`);
    }

    const won = pos.numbers.includes(winningNumber);
    const profit = won ? bet.stake * payout : 0;
    const returned = won ? bet.stake + profit : 0;
    totalStake += bet.stake;
    if (won) stakeReturned += bet.stake;
    winnings += profit;
    settled.push({ key: bet.key, won, returned });
  }

  const totalReturned = stakeReturned + winnings;
  if (![totalStake, stakeReturned, winnings, totalReturned].every(Number.isSafeInteger)) {
    throw new GameError('internal', 'Settlement amounts exceed the safe integer range');
  }
  return {
    winningNumber,
    totalStake,
    stakeReturned,
    winnings,
    totalReturned,
    net: totalReturned - totalStake,
    bets: settled,
  };
}

/** Generate every legal position once, in a stable order (see allBetPositions). */
function generatePositions(): Omit<BetInput, 'stake'>[] {
  const out: Omit<BetInput, 'stake'>[] = [];
  const inside = (type: BetType, numbers: number[]) => out.push({ type, numbers });

  for (let n = 0; n <= 36; n++) inside('straight', [n]);
  for (const n of [1, 2, 3]) inside('split', [0, n]);
  for (let n = 1; n <= 36; n++) {
    if (n % 3 !== 0) inside('split', [n, n + 1]); // same layout column
    if (n <= 33) inside('split', [n, n + 3]); // same row
  }
  for (let n = 1; n <= 34; n += 3) inside('street', [n, n + 1, n + 2]);
  inside('trio', [0, 1, 2]);
  inside('trio', [0, 2, 3]);
  for (let n = 1; n <= 32; n++) {
    if (n % 3 !== 0) inside('corner', [n, n + 1, n + 3, n + 4]);
  }
  inside('firstFour', [0, 1, 2, 3]);
  for (let n = 1; n <= 31; n += 3) inside('sixLine', range(n, n + 5));
  for (const index of [1, 2, 3]) out.push({ type: 'dozen', index });
  for (const index of [1, 2, 3]) out.push({ type: 'column', index });
  for (const type of EVEN_MONEY_TYPES) out.push({ type });
  return out;
}

let positionsCache: readonly Omit<BetInput, 'stake'>[] | null = null;

/**
 * Every legal bet position on the European layout (no stake), e.g. for UI hit-zones and exhaustive tests.
 * 157 positions: 37 straight, 60 split (57 + 3 zero splits), 12 street, 2 trio, 22 corner,
 * 1 first four, 11 six line, 3 dozen, 3 column, 6 even-money. Returns fresh objects on every call.
 */
export function allBetPositions(): Omit<BetInput, 'stake'>[] {
  positionsCache ??= generatePositions();
  return positionsCache.map((p) => (p.numbers ? { ...p, numbers: [...p.numbers] } : { ...p }));
}

/**
 * Human label, e.g. "Straight 17", "Split 0/3", "Street 7-8-9", "Corner 1/2/4/5",
 * "Six line 1-6", "1st Dozen (1-12)", "Column 2", "Red", "Low (1-18)".
 * Throws GameError('invalid_bet') for an illegal position.
 */
export function describeBet(bet: Omit<BetInput, 'stake'>): string {
  return resolvePosition(bet).label;
}
