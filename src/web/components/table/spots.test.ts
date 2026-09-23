import { describe, expect, it } from 'vitest';
import { allBetPositions, betKey, PAYOUTS } from '../../../shared/bets';
import { chipValuesFor, coerceChipValue } from '../controls/chips';
import { chipLabel } from './chipFormat';
import {
  allSpots,
  findSpot,
  hitTest,
  neighborInDirection,
  orientationForWidth,
  spokenLabel,
  spotForRoundBet,
  tableLayout,
  type LaidOutSpot,
  type NavDirection,
  type Orientation,
  type TableLayout,
} from './spots';

const ORIENTATIONS: Orientation[] = ['horizontal', 'vertical'];
const k = (type: string, numbers?: number[], index?: number) =>
  betKey({ type: type as never, ...(numbers ? { numbers } : {}), ...(index ? { index } : {}) });
const at = (layout: TableLayout, key: string): LaidOutSpot => {
  const s = layout.byKey.get(key);
  if (!s) throw new Error(`missing spot ${key}`);
  return s;
};
const cellOf = (layout: TableLayout, n: number) => at(layout, k('straight', [n]));
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('spot catalogue', () => {
  it('has one spot per legal position with unique canonical keys', () => {
    const spots = allSpots();
    expect(spots.length).toBe(allBetPositions().length);
    expect(spots.length).toBe(157);
    expect(new Set(spots.map((s) => s.key)).size).toBe(spots.length);
    for (const s of spots) {
      expect(s.key).toBe(betKey(s.bet));
      expect(s.payout).toBe(PAYOUTS[s.bet.type]);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('contains every straight number 0-36 exactly once', () => {
    const straights = allSpots().filter((s) => s.bet.type === 'straight');
    const numbers = straights.map((s) => s.bet.numbers![0]).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });

  it('maps server round bets back to spots by key or by position', () => {
    expect(findSpot('dozen:2')?.bet).toEqual({ type: 'dozen', index: 2 });
    // RoundBet.numbers for a dozen lists covered numbers; the spot keeps the index-only position.
    const viaKey = spotForRoundBet({ key: 'dozen:2', type: 'dozen', numbers: [13, 14], index: 2 });
    expect(viaKey?.bet).toEqual({ type: 'dozen', index: 2 });
    const viaPosition = spotForRoundBet({ key: 'unknown-key', type: 'split', numbers: [11, 8] });
    expect(viaPosition?.key).toBe(k('split', [8, 11]));
    expect(spotForRoundBet({ key: 'nope', type: 'split', numbers: [3, 4] })).toBeUndefined();
  });
});

describe.each(ORIENTATIONS)('%s geometry', (orientation) => {
  const layout = tableLayout(orientation);

  it('lays out all 157 spots inside the table bounds', () => {
    expect(layout.spots.length).toBe(157);
    for (const s of layout.spots) {
      expect(s.rect.w).toBeGreaterThan(0);
      expect(s.rect.h).toBeGreaterThan(0);
      expect(s.rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(s.rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(layout.width + 1e-9);
      expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(layout.height + 1e-9);
    }
  });

  it('assigns layers: corners/intersections over splits/edges over straights/outside cells', () => {
    const expected: Record<string, number> = {
      straight: 0, dozen: 0, column: 0, red: 0, black: 0, odd: 0, even: 0, low: 0, high: 0,
      split: 1, street: 1, corner: 2, sixLine: 2, trio: 2, firstFour: 2,
    };
    for (const s of layout.spots) expect(s.layer).toBe(expected[s.spot.bet.type]);
  });

  it('every spot is reachable by pointer: its own centre hit-tests to itself', () => {
    for (const s of layout.spots) {
      expect(hitTest(layout, s.cx, s.cy)?.spot.key).toBe(s.spot.key);
    }
  });

  it('places splits on the shared edge and corners on the shared intersection', () => {
    const split = at(layout, k('split', [8, 11]));
    close(split.cx, (cellOf(layout, 8).cx + cellOf(layout, 11).cx) / 2);
    close(split.cy, (cellOf(layout, 8).cy + cellOf(layout, 11).cy) / 2);
    const vsplit = at(layout, k('split', [7, 8]));
    close(vsplit.cx, (cellOf(layout, 7).cx + cellOf(layout, 8).cx) / 2);
    close(vsplit.cy, (cellOf(layout, 7).cy + cellOf(layout, 8).cy) / 2);
    const corner = at(layout, k('corner', [1, 2, 4, 5]));
    const cs = [1, 2, 4, 5].map((n) => cellOf(layout, n));
    close(corner.cx, cs.reduce((a, c) => a + c.cx, 0) / 4);
    close(corner.cy, cs.reduce((a, c) => a + c.cy, 0) / 4);
  });

  it('puts streets and six lines on the outer edge nearest the dozens', () => {
    const seven = cellOf(layout, 7);
    const street = at(layout, k('street', [7, 8, 9]));
    const six = at(layout, k('sixLine', [1, 2, 3, 4, 5, 6]));
    const dozen = at(layout, k('dozen', undefined, 1));
    if (orientation === 'horizontal') {
      close(street.cx, seven.cx);
      close(street.cy, seven.rect.y + seven.rect.h); // bottom edge under the 1,4,7… row
      close(dozen.rect.y, street.cy); // …which is the top edge of the dozens row
      close(six.cx, cellOf(layout, 1).rect.x + cellOf(layout, 1).rect.w);
      close(six.cy, street.cy);
    } else {
      close(street.cy, seven.cy);
      close(street.cx, seven.rect.x); // left edge of the 7,8,9 row, next to the dozens column
      close(dozen.rect.x + dozen.rect.w, street.cx);
      close(six.cx, street.cx);
      close(six.cy, cellOf(layout, 1).rect.y + cellOf(layout, 1).rect.h);
    }
  });

  it('puts zero splits, trios and the first four on the zero boundary', () => {
    const zero = cellOf(layout, 0);
    const boundary = orientation === 'horizontal' ? zero.rect.x + zero.rect.w : zero.rect.y + zero.rect.h;
    const along = (s: LaidOutSpot) => (orientation === 'horizontal' ? s.cx : s.cy);
    const across = (s: LaidOutSpot) => (orientation === 'horizontal' ? s.cy : s.cx);
    for (const n of [1, 2, 3]) {
      const zs = at(layout, k('split', [0, n]));
      close(along(zs), boundary);
      close(across(zs), across(cellOf(layout, n)));
    }
    const trio012 = at(layout, k('trio', [0, 1, 2]));
    close(along(trio012), boundary);
    close(across(trio012), (across(cellOf(layout, 1)) + across(cellOf(layout, 2))) / 2);
    const trio023 = at(layout, k('trio', [0, 2, 3]));
    close(across(trio023), (across(cellOf(layout, 2)) + across(cellOf(layout, 3))) / 2);
    const ff = at(layout, k('firstFour', [0, 1, 2, 3]));
    close(along(ff), boundary);
    close(across(ff), across(at(layout, k('street', [1, 2, 3])))); // the outer corner of 0 and 1
  });

  it('every spot is reachable with the arrow keys from the zero', () => {
    const seen = new Set<string>([layout.homeKey]);
    const queue = [layout.homeKey];
    const dirs: NavDirection[] = ['up', 'down', 'left', 'right'];
    while (queue.length) {
      const key = queue.shift()!;
      for (const d of dirs) {
        const next = neighborInDirection(layout, key, d);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(157);
  });
});

describe('layout specifics', () => {
  it('horizontal: 3 on the top row, 1 on the bottom row, column 3 top-right, 0 left', () => {
    const h = tableLayout('horizontal');
    expect(cellOf(h, 3).cy).toBeLessThan(cellOf(h, 2).cy);
    expect(cellOf(h, 2).cy).toBeLessThan(cellOf(h, 1).cy);
    expect(cellOf(h, 0).cx).toBeLessThan(cellOf(h, 1).cx);
    expect(at(h, 'column:3').cy).toBeCloseTo(cellOf(h, 36).cy);
    expect(at(h, 'column:3').cx).toBeGreaterThan(cellOf(h, 36).cx);
    expect(h.width).toBeGreaterThan(h.height);
  });

  it('vertical: zero on top, 1-2-3 in the first row, 34-35-36 last, "2 to 1" at the bottom', () => {
    const v = tableLayout('vertical');
    expect(cellOf(v, 0).cy).toBeLessThan(cellOf(v, 1).cy);
    close(cellOf(v, 1).cy, cellOf(v, 3).cy);
    expect(cellOf(v, 1).cx).toBeLessThan(cellOf(v, 3).cx);
    expect(cellOf(v, 34).cy).toBeGreaterThan(cellOf(v, 31).cy);
    expect(at(v, 'column:1').cy).toBeGreaterThan(cellOf(v, 34).cy);
    expect(at(v, 'dozen:1').cx).toBeLessThan(cellOf(v, 1).cx);
    expect(v.height).toBeGreaterThan(v.width);
  });

  it('vertical hit zones are at least 24px on a 328px-wide phone table (360px screen, 16px gutters)', () => {
    const v = tableLayout('vertical');
    const px = 328 / v.width;
    for (const s of v.spots) {
      if (s.shape === 'cell') continue;
      expect(Math.min(s.rect.w, s.rect.h) * px).toBeGreaterThanOrEqual(24);
    }
    // The part of a straight cell not covered by the surrounding edge zones is tappable too.
    const eight = cellOf(v, 8);
    const edge = at(v, k('split', [7, 8]));
    const thickness = Math.min(edge.rect.w, edge.rect.h);
    expect((eight.rect.h - thickness) * px).toBeGreaterThanOrEqual(24);
    expect((eight.rect.w - thickness) * px).toBeGreaterThanOrEqual(24);
  });

  it('chooses the orientation from the container width', () => {
    expect(orientationForWidth(639)).toBe('vertical');
    expect(orientationForWidth(640)).toBe('horizontal');
  });

  it('arrow keys step through the zones between numbers', () => {
    const h = tableLayout('horizontal');
    const eight = k('straight', [8]);
    expect(neighborInDirection(h, eight, 'right')).toBe(k('split', [8, 11]));
    expect(neighborInDirection(h, k('split', [8, 11]), 'right')).toBe(k('straight', [11]));
    expect(neighborInDirection(h, eight, 'down')).toBe(k('split', [7, 8]));
    expect(neighborInDirection(h, k('straight', [3]), 'up')).toBeNull();
  });
});

describe('labels', () => {
  it('spells inside bets for screen readers', () => {
    expect(spokenLabel(findSpot(k('split', [8, 11]))!)).toBe('Split 8 and 11');
    expect(spokenLabel(findSpot(k('corner', [1, 2, 4, 5]))!)).toBe('Corner 1, 2, 4 and 5');
    expect(spokenLabel(findSpot(k('street', [7, 8, 9]))!)).toBe('Street 7 to 9');
    expect(spokenLabel(findSpot(k('sixLine', [1, 2, 3, 4, 5, 6]))!)).toBe('Six line 1 to 6');
    expect(spokenLabel(findSpot(k('trio', [0, 1, 2]))!)).toBe('Trio 0, 1 and 2');
    expect(spokenLabel(findSpot(k('straight', [0]))!)).toBe('Straight 0');
    expect(spokenLabel(findSpot('red')!)).toBe('Red');
  });

  it('formats compact chip faces with integer math', () => {
    expect(chipLabel(10)).toBe('.10');
    expect(chipLabel(50)).toBe('.50');
    expect(chipLabel(100)).toBe('1');
    expect(chipLabel(150)).toBe('1.50');
    expect(chipLabel(2500)).toBe('25');
    expect(chipLabel(10000)).toBe('100');
    expect(chipLabel(125_000)).toBe('1.2K');
    expect(chipLabel(199_999)).toBe('1.9K'); // truncated, never rounded up
    expect(chipLabel(12_500_000)).toBe('125K');
    expect(chipLabel(250_000_000)).toBe('2.5M');
  });
});

describe('chip denominations', () => {
  it('keeps chips >= minStake, multiples of stakeIncrement and <= maxStakePerBet', () => {
    expect(chipValuesFor({ minStake: 10, stakeIncrement: 10, maxStakePerBet: 10_000 })).toEqual([10, 50, 100, 500, 2500, 10000]);
    expect(chipValuesFor({ minStake: 100, stakeIncrement: 100, maxStakePerBet: 10_000 })).toEqual([100, 500, 2500, 10000]);
    expect(chipValuesFor({ minStake: 10, stakeIncrement: 20, maxStakePerBet: 10_000 })).toEqual([100, 500, 2500, 10000]);
    expect(chipValuesFor({ minStake: 10, stakeIncrement: 10, maxStakePerBet: 500 })).toEqual([10, 50, 100, 500]);
    expect(chipValuesFor({ minStake: 10, stakeIncrement: 0, maxStakePerBet: 500 })).toEqual([]);
  });

  it('coerces the selected chip into the allowed set', () => {
    expect(coerceChipValue(50, [10, 50])).toBe(50);
    expect(coerceChipValue(50, [100, 500])).toBe(100);
    expect(coerceChipValue(50, [])).toBeNull();
  });
});
