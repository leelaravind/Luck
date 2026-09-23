/**
 * European single-zero roulette constants shared by the engine and the UI.
 * Pure data: no randomness, no settlement logic.
 */

/** Clockwise pocket order on a European (single-zero) wheel, starting at 0. */
export const WHEEL_ORDER: readonly number[] = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]);

export const POCKET_COUNT = 37;

export const RED_NUMBERS: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export type PocketColor = 'red' | 'black' | 'green';

export function isRouletteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 36;
}

export function colorOf(n: number): PocketColor {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

/** Index of a number in WHEEL_ORDER (0..36). */
export function wheelIndexOf(n: number): number {
  const i = WHEEL_ORDER.indexOf(n);
  if (i < 0) throw new RangeError(`Not a roulette number: ${n}`);
  return i;
}

/**
 * Betting-layout coordinates for numbers 1..36.
 * column = 1..12 (left to right), row = 1..3 where row 1 holds 1,4,7…34 (nearest the player)
 * and row 3 holds 3,6,9…36 (the "top" row in the horizontal layout).
 */
export function layoutPosition(n: number): { column: number; row: number } {
  if (!Number.isInteger(n) || n < 1 || n > 36) throw new RangeError(`No layout cell for ${n}`);
  return { column: Math.ceil(n / 3), row: ((n - 1) % 3) + 1 };
}
