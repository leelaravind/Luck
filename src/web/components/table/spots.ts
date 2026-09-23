/**
 * OWNER: betting-table agent (A5). Bet spots + hit-zone geometry for the European layout.
 *
 * Every spot is derived from the shared rules (allBetPositions + betKey + describeBet + PAYOUTS),
 * so the table can never offer a position the backend does not know. This module is pure data:
 * it decides WHERE a bet can be tapped, never whether it is affordable or what it pays out.
 *
 * Geometry is expressed in abstract "layout units" (1 unit ≈ one number-cell width in the
 * horizontal layout). The renderer converts units to percentages of the table box, so the
 * layout scales with its container.
 *
 * Inside bets are placed on a "lattice" first and then mapped per orientation:
 *   a = position along the 12 layout columns (a = c − 0.5 is the centre of column c,
 *       a = c is the boundary after column c, a = 0 is the boundary with the zero)
 *   b = position across the 3 rows (b = r − 0.5 is the centre of row r, b = r is the boundary
 *       between rows r and r+1, b = 0 is the OUTER edge next to the dozens)
 * A half-integer on both axes is a cell (straight), on one axis an edge (split, street, zero
 * split) and on neither an intersection (corner, six line, trio, first four).
 */
import { allBetPositions, betKey, describeBet, PAYOUTS } from '../../../shared/bets';
import type { BetInput, RoundBet } from '../../../shared/contracts';
import { colorOf, layoutPosition, type PocketColor } from '../../../shared/roulette';
import type { BetSpot } from '../../contracts';

export type Orientation = 'horizontal' | 'vertical';

/** Container width (CSS px) from which the horizontal layout is used. */
export const HORIZONTAL_MIN_WIDTH = 640;

/** cell = full rectangle (straight / outside); edge = shared border; point = shared intersection. */
export type SpotShape = 'cell' | 'edge' | 'point';

/** Stacking order for overlapping hit zones: corners over splits over straights. */
export type SpotLayer = 0 | 1 | 2;

export interface SpotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the renderer should paint inside a cell (zones are invisible until hovered/focused). */
export type SpotVisual =
  | { kind: 'number'; n: number; color: PocketColor }
  | { kind: 'outside'; text: string; tone: 'felt' | 'red' | 'black' }
  | { kind: 'zone' };

export interface LaidOutSpot {
  spot: BetSpot;
  /** Numbers the bet covers (sorted), used for hover/focus coverage highlighting. */
  covers: readonly number[];
  shape: SpotShape;
  layer: SpotLayer;
  /** Hit zone in layout units. */
  rect: SpotRect;
  /** Centre of the hit zone (chip position and keyboard-navigation coordinate). */
  cx: number;
  cy: number;
  visual: SpotVisual;
}

export interface TableLayout {
  orientation: Orientation;
  /** Total size in layout units. */
  width: number;
  height: number;
  /** Size of one number cell in layout units (used for chip sizing). */
  cell: { w: number; h: number };
  /** All spots in reading order (top-to-bottom, then left-to-right by centre). */
  spots: readonly LaidOutSpot[];
  byKey: ReadonlyMap<string, LaidOutSpot>;
  /** Home key (the zero). */
  homeKey: string;
  /** Last spot in reading order. */
  endKey: string;
}

// ───────────────────────────── spot catalogue ─────────────────────────────

let spotCache: readonly BetSpot[] | null = null;

/** Every bet spot on the table, one per legal position (157), in allBetPositions() order. */
export function allSpots(): readonly BetSpot[] {
  spotCache ??= Object.freeze(
    allBetPositions().map((pos): BetSpot => {
      const bet: Omit<BetInput, 'stake'> = { type: pos.type };
      if (pos.numbers) bet.numbers = [...pos.numbers].sort((x, y) => x - y);
      if (pos.index !== undefined) bet.index = pos.index;
      return { key: betKey(bet), bet, label: describeBet(bet), payout: PAYOUTS[bet.type] };
    }),
  );
  return spotCache;
}

let spotIndex: ReadonlyMap<string, BetSpot> | null = null;

/** Look up a spot by its canonical key ("split:8-11", "dozen:2", "red"). */
export function findSpot(key: string): BetSpot | undefined {
  spotIndex ??= new Map(allSpots().map((s) => [s.key, s]));
  return spotIndex.get(key);
}

/**
 * Map a committed/settled server bet back onto a table spot. Uses the server's canonical key
 * first, then re-derives the key from type + numbers/index. Returns undefined if it is not a
 * position on this layout (never guesses a different bet).
 */
export function spotForRoundBet(rb: Pick<RoundBet, 'key' | 'type' | 'numbers' | 'index'>): BetSpot | undefined {
  const direct = findSpot(rb.key);
  if (direct) return direct;
  const bet: Omit<BetInput, 'stake'> = { type: rb.type };
  if (rb.type === 'dozen' || rb.type === 'column') bet.index = rb.index;
  else if (!isEvenMoney(rb.type)) bet.numbers = [...rb.numbers];
  try {
    return findSpot(betKey(bet));
  } catch {
    return undefined;
  }
}

function isEvenMoney(t: BetInput['type']): boolean {
  return t === 'red' || t === 'black' || t === 'odd' || t === 'even' || t === 'low' || t === 'high';
}

/** Numbers a spot covers, derived from its bet position. */
export function coveredNumbers(bet: Omit<BetInput, 'stake'>): number[] {
  const all = Array.from({ length: 36 }, (_, i) => i + 1);
  switch (bet.type) {
    case 'dozen':
      return all.filter((n) => Math.ceil(n / 12) === bet.index);
    case 'column':
      return all.filter((n) => ((n - 1) % 3) + 1 === bet.index);
    case 'red':
      return all.filter((n) => colorOf(n) === 'red');
    case 'black':
      return all.filter((n) => colorOf(n) === 'black');
    case 'odd':
      return all.filter((n) => n % 2 === 1);
    case 'even':
      return all.filter((n) => n % 2 === 0);
    case 'low':
      return all.filter((n) => n <= 18);
    case 'high':
      return all.filter((n) => n >= 19);
    default:
      return [...(bet.numbers ?? [])].sort((x, y) => x - y);
  }
}

// ───────────────────────────── lattice placement of inside bets ─────────────────────────────

interface Lattice {
  a: number;
  b: number;
}

/** Lattice point of an inside bet (and of numbers 1-36). Throws for an unknown combination. */
function latticeOf(bet: Omit<BetInput, 'stake'>): Lattice {
  const s = [...(bet.numbers ?? [])].sort((x, y) => x - y);
  const lo = s[0];
  const fail = (): never => {
    throw new Error(`No table geometry for ${bet.type} ${s.join('/')}`);
  };
  switch (bet.type) {
    case 'straight': {
      if (lo === 0) return fail(); // the zero is a special cell, handled by the caller
      const { column, row } = layoutPosition(lo);
      return { a: column - 0.5, b: row - 0.5 };
    }
    case 'split': {
      const hi = s[1];
      if (lo === 0) return { a: 0, b: hi - 0.5 }; // edge between 0 and 1/2/3
      const { column, row } = layoutPosition(lo);
      if (hi - lo === 3) return { a: column, b: row - 0.5 }; // neighbours in the same row
      if (hi - lo === 1) return { a: column - 0.5, b: row }; // neighbours in the same layout column
      return fail();
    }
    case 'street':
      return { a: layoutPosition(lo).column - 0.5, b: 0 };
    case 'sixLine':
      return { a: layoutPosition(lo).column, b: 0 };
    case 'corner': {
      const { column, row } = layoutPosition(lo);
      return { a: column, b: row };
    }
    case 'trio':
      // 0/1/2 meets at the 1|2 boundary, 0/2/3 at the 2|3 boundary.
      if (s.join('-') === '0-1-2') return { a: 0, b: 1 };
      if (s.join('-') === '0-2-3') return { a: 0, b: 2 };
      return fail();
    case 'firstFour':
      return { a: 0, b: 0 };
    default:
      return fail();
  }
}

// ───────────────────────────── orientation metrics ─────────────────────────────

/**
 * Horizontal (desktop): zero column left, 12 columns × 3 rows (3,6,…36 on top), "2 to 1" on the right,
 * dozens row, even-money row. Vertical (mobile): zero on top, 12 rows × 3 columns, "2 to 1" row at the
 * bottom, dozens and even-money columns along the left side.
 */
const H = { cellW: 1, rowH: 1.1, zeroW: 1, colBetW: 1, dozenH: 0.8, evenH: 0.8, hit: 0.44 } as const;
const V = { cellW: 1.35, rowH: 0.9, zeroH: 1, colBetH: 0.8, evenW: 0.9, dozenW: 0.9, hit: 0.44 } as const;

interface Metrics {
  width: number;
  height: number;
  cell: { w: number; h: number };
  hit: number;
  /** Physical centre of a lattice point. */
  toXY(p: Lattice): { x: number; y: number };
  /** Physical size of a zone with the given extent along a and b (in lattice units or 'hit'). */
  size(alongA: number | 'hit', alongB: number | 'hit'): { w: number; h: number };
  zero: SpotRect;
  dozen(i: number): SpotRect;
  column(i: number): SpotRect;
  /** Even-money cell by position 0..5 (low, even, red, black, odd, high). */
  even(i: number): SpotRect;
}

function metricsFor(orientation: Orientation): Metrics {
  if (orientation === 'horizontal') {
    const numbersRight = H.zeroW + 12 * H.cellW;
    return {
      width: numbersRight + H.colBetW,
      height: 3 * H.rowH + H.dozenH + H.evenH,
      cell: { w: H.cellW, h: H.rowH },
      hit: H.hit,
      toXY: ({ a, b }) => ({ x: H.zeroW + a * H.cellW, y: (3 - b) * H.rowH }),
      size: (alongA, alongB) => ({
        w: alongA === 'hit' ? H.hit : alongA * H.cellW,
        h: alongB === 'hit' ? H.hit : alongB * H.rowH,
      }),
      zero: { x: 0, y: 0, w: H.zeroW, h: 3 * H.rowH },
      dozen: (i) => ({ x: H.zeroW + (i - 1) * 4 * H.cellW, y: 3 * H.rowH, w: 4 * H.cellW, h: H.dozenH }),
      column: (i) => ({ x: numbersRight, y: (3 - i) * H.rowH, w: H.colBetW, h: H.rowH }),
      even: (i) => ({ x: H.zeroW + i * 2 * H.cellW, y: 3 * H.rowH + H.dozenH, w: 2 * H.cellW, h: H.evenH }),
    };
  }
  const x0 = V.evenW + V.dozenW;
  const numbersBottom = V.zeroH + 12 * V.rowH;
  return {
    width: x0 + 3 * V.cellW,
    height: numbersBottom + V.colBetH,
    cell: { w: V.cellW, h: V.rowH },
    hit: V.hit,
    toXY: ({ a, b }) => ({ x: x0 + b * V.cellW, y: V.zeroH + a * V.rowH }),
    size: (alongA, alongB) => ({
      w: alongB === 'hit' ? V.hit : alongB * V.cellW,
      h: alongA === 'hit' ? V.hit : alongA * V.rowH,
    }),
    zero: { x: x0, y: 0, w: 3 * V.cellW, h: V.zeroH },
    dozen: (i) => ({ x: V.evenW, y: V.zeroH + (i - 1) * 4 * V.rowH, w: V.dozenW, h: 4 * V.rowH }),
    column: (i) => ({ x: x0 + (i - 1) * V.cellW, y: numbersBottom, w: V.cellW, h: V.colBetH }),
    even: (i) => ({ x: 0, y: V.zeroH + i * 2 * V.rowH, w: V.evenW, h: 2 * V.rowH }),
  };
}

const EVEN_ORDER = ['low', 'even', 'red', 'black', 'odd', 'high'] as const;
const EVEN_TEXT: Record<(typeof EVEN_ORDER)[number], string> = {
  low: '1 to 18',
  even: 'Even',
  red: 'Red',
  black: 'Black',
  odd: 'Odd',
  high: '19 to 36',
};
const DOZEN_TEXT = ['', '1st 12', '2nd 12', '3rd 12'];

const isHalf = (v: number) => !Number.isInteger(v);

function place(spot: BetSpot, m: Metrics): Omit<LaidOutSpot, 'spot' | 'covers'> {
  const { bet } = spot;
  const cellFrom = (rect: SpotRect, visual: SpotVisual) => ({
    shape: 'cell' as const,
    layer: 0 as const,
    rect,
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    visual,
  });

  switch (bet.type) {
    case 'dozen':
      return cellFrom(m.dozen(bet.index!), { kind: 'outside', text: DOZEN_TEXT[bet.index!], tone: 'felt' });
    case 'column':
      return cellFrom(m.column(bet.index!), { kind: 'outside', text: '2 to 1', tone: 'felt' });
    case 'low':
    case 'even':
    case 'red':
    case 'black':
    case 'odd':
    case 'high': {
      const tone = bet.type === 'red' ? 'red' : bet.type === 'black' ? 'black' : 'felt';
      return cellFrom(m.even(EVEN_ORDER.indexOf(bet.type)), { kind: 'outside', text: EVEN_TEXT[bet.type], tone });
    }
    case 'straight':
      if (bet.numbers?.[0] === 0) return cellFrom(m.zero, { kind: 'number', n: 0, color: 'green' });
      break;
    default:
      break;
  }

  const p = latticeOf(bet);
  const { x, y } = m.toXY(p);
  const aHalf = isHalf(p.a);
  const bHalf = isHalf(p.b);
  const shape: SpotShape = aHalf && bHalf ? 'cell' : aHalf || bHalf ? 'edge' : 'point';
  // A cell spans one lattice step on both axes; an edge spans one step along its length and the
  // hit thickness across; a point is a hit × hit square. Edges run the full cell length and the
  // point zones (higher layer) sit on top of their ends.
  const { w, h } = m.size(aHalf ? 1 : 'hit', bHalf ? 1 : 'hit');
  const layer: SpotLayer = shape === 'cell' ? 0 : shape === 'edge' ? 1 : 2;
  const n = bet.numbers![0];
  const visual: SpotVisual = shape === 'cell' ? { kind: 'number', n, color: colorOf(n) } : { kind: 'zone' };
  return { shape, layer, rect: { x: x - w / 2, y: y - h / 2, w, h }, cx: x, cy: y, visual };
}

const layoutCache = new Map<Orientation, TableLayout>();

/** Full table layout for one orientation (cached; spots and geometry never change). */
export function tableLayout(orientation: Orientation): TableLayout {
  const cached = layoutCache.get(orientation);
  if (cached) return cached;
  const m = metricsFor(orientation);
  const spots = allSpots()
    .map((spot): LaidOutSpot => ({ spot, covers: coveredNumbers(spot.bet), ...place(spot, m) }))
    .sort((p, q) => p.cy - q.cy || p.cx - q.cx);
  const byKey = new Map(spots.map((s) => [s.spot.key, s]));
  const layout: TableLayout = {
    orientation,
    width: m.width,
    height: m.height,
    cell: m.cell,
    spots,
    byKey,
    homeKey: betKey({ type: 'straight', numbers: [0] }),
    endKey: spots[spots.length - 1].spot.key,
  };
  layoutCache.set(orientation, layout);
  return layout;
}

/**
 * Which spot a pointer at (x, y) layout units would hit: the highest layer containing the point
 * (corners over splits over straights); within a layer the later spot in DOM/reading order wins,
 * matching the renderer's stacking. Returns null outside every zone.
 */
export function hitTest(layout: TableLayout, x: number, y: number): LaidOutSpot | null {
  let best: LaidOutSpot | null = null;
  for (const s of layout.spots) {
    const r = s.rect;
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    if (!best || s.layer >= best.layer) best = s;
  }
  return best;
}

export function orientationForWidth(widthPx: number): Orientation {
  return widthPx >= HORIZONTAL_MIN_WIDTH ? 'horizontal' : 'vertical';
}

// ───────────────────────────── keyboard navigation ─────────────────────────────

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** Sideways drift is penalised this much more than distance along the arrow direction. */
const ORTHOGONAL_WEIGHT = 2.5;

/**
 * Nearest spot from `fromKey` in an arrow direction, using hit-zone centres on the 2-D table.
 * Returns null at the edge of the table.
 */
export function neighborInDirection(layout: TableLayout, fromKey: string, dir: NavDirection): string | null {
  const from = layout.byKey.get(fromKey);
  if (!from) return layout.homeKey;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const s of layout.spots) {
    if (s === from) continue;
    const dx = s.cx - from.cx;
    const dy = s.cy - from.cy;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1e-6) continue;
    const score = along + ORTHOGONAL_WEIGHT * across;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = s.spot.key;
    }
  }
  return best;
}

// ───────────────────────────── accessible names ─────────────────────────────

function listWords(ns: readonly number[]): string {
  if (ns.length <= 1) return ns.join('');
  if (ns.length === 2) return `${ns[0]} and ${ns[1]}`;
  return `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
}

/**
 * Speakable bet name, e.g. "Split 8 and 11", "Corner 1, 2, 4 and 5", "Street 7 to 9".
 * Inside bets are spelled from their numbers (screen readers read "8/11" poorly);
 * outside bets use the shared describeBet() label ("2nd Dozen (13-24)", "Red").
 */
export function spokenLabel(spot: BetSpot): string {
  const ns = [...(spot.bet.numbers ?? [])].sort((x, y) => x - y);
  switch (spot.bet.type) {
    case 'straight':
      return `Straight ${ns[0]}`;
    case 'split':
      return `Split ${listWords(ns)}`;
    case 'trio':
      return `Trio ${listWords(ns)}`;
    case 'corner':
      return `Corner ${listWords(ns)}`;
    case 'firstFour':
      return `First four ${listWords(ns)}`;
    case 'street':
      return `Street ${ns[0]} to ${ns[ns.length - 1]}`;
    case 'sixLine':
      return `Six line ${ns[0]} to ${ns[ns.length - 1]}`;
    default:
      return spot.label.replace(/(\d+)-(\d+)/g, '$1 to $2');
  }
}
