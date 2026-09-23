/**
 * OWNER: betting-table agent (A5). Complete European betting layout (all 157 positions).
 *
 * Presentational: it shows draft chips (client-side, manual mode) and committed bets (from the
 * server, read-only) and reports taps through onPlace / onRemove. It never validates stakes,
 * computes payouts or decides results; `highlightNumber` is the revealed result from the parent.
 *
 * Interaction:
 *   tap / click / Enter / Space           → onPlace(spot)
 *   Shift+click, right-click, long-press,
 *   Delete / Backspace                    → onRemove(spot)
 *   Arrow keys                            → nearest spot in that direction (roving tabindex)
 *   Home / End                            → the zero / the last spot
 * Orientation follows the container width (horizontal ≥ 640px, else vertical), via ResizeObserver.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatCredits } from '../../../shared/money';
import type { Subunits } from '../../../shared/contracts';
import type { BetSpot, BettingTableProps } from '../../contracts';
import { Chip } from './Chip';
import {
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

export type { BettingTableProps };

export interface BettingTableExtraProps {
  /** Force an orientation (tests, previews). Default: chosen from the measured container width. */
  readonly orientation?: Orientation;
  readonly className?: string;
}

/** How long a touch must be held to remove a chip. */
export const LONG_PRESS_MS = 500;

/** Vertical layouts are capped so cells stay finger-sized rather than huge on tablets in portrait. */
const VERTICAL_MAX_WIDTH_PX = 420;

const ARROWS: Record<string, NavDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// ───────────────────────────── container measurement ─────────────────────────────

/** Measured width of the wrapper (0 until laid out, and in environments without layout). */
function useContainerWidth(ref: RefObject<HTMLDivElement | null>, enabled: boolean): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const read = (w: number) => setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : Math.round(w)));
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) read(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return width;
}

// ───────────────────────────── one spot ─────────────────────────────

interface SpotViewProps {
  ls: LaidOutSpot;
  layout: TableLayout;
  draftStake: Subunits;
  committedStake: Subunits;
  committedWon: boolean;
  isActive: boolean;
  covered: boolean;
  isWinner: boolean;
  disabled: boolean;
  chipPx: number;
}

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

function accessibleName(p: SpotViewProps): string {
  const { spot } = p.ls;
  let name = `${spokenLabel(spot)}, pays ${spot.payout} to 1, your stake ${formatCredits(p.draftStake)}`;
  if (p.committedStake > 0) name += `, committed ${formatCredits(p.committedStake)}`;
  if (p.isWinner) name += ', winning number';
  return name;
}

const NUMBER_BG = { red: 'bg-pocket-red', black: 'bg-pocket-black', green: 'bg-pocket-green' } as const;
const OUTSIDE_TONE = {
  felt: 'bg-felt-cell text-champagne',
  red: 'bg-pocket-red text-white',
  black: 'bg-pocket-black text-white',
} as const;
const LAYER_Z = ['z-0', 'z-10', 'z-20'] as const;

/**
 * Where a chip sits inside its spot. Inside bets: exactly on the hit-zone centre (number centre,
 * shared edge or intersection). Outside cells: towards the far end so the label stays readable.
 */
function chipAnchor(ls: LaidOutSpot): { left: string; top: string } {
  if (ls.visual.kind !== 'outside') return { left: '50%', top: '50%' };
  return ls.rect.w >= ls.rect.h ? { left: '82%', top: '50%' } : { left: '50%', top: '82%' };
}

const SpotView = memo(function SpotView(p: SpotViewProps) {
  const { ls, layout, disabled } = p;
  const { rect, visual, shape } = ls;
  const vertical = layout.orientation === 'vertical';

  const rounded =
    visual.kind === 'number' && visual.n === 0 ? (vertical ? 'rounded-t-md' : 'rounded-l-md') : '';
  let face: ReactNode = null;
  if (visual.kind === 'number') {
    face = (
      <span
        className={[
          'absolute inset-px flex items-center justify-center font-mono font-bold text-white',
          NUMBER_BG[visual.color],
          rounded,
          disabled ? '' : 'group-hover:brightness-125',
          p.isWinner ? 'ring-2 ring-inset ring-champagne-pale' : '',
        ].join(' ')}
        style={{ fontSize: vertical ? 'clamp(12px, 4.6cqw, 18px)' : 'clamp(11px, 2.3cqw, 19px)' }}
      >
        {visual.n}
        {p.isWinner && (
          <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-champagne-pale" />
        )}
      </span>
    );
  } else if (visual.kind === 'outside') {
    const sideways = vertical && ls.spot.bet.type !== 'column';
    face = (
      <span
        className={[
          'absolute inset-px flex items-center justify-center gap-1 font-sans font-semibold uppercase tracking-tight',
          OUTSIDE_TONE[visual.tone],
          disabled ? '' : 'group-hover:brightness-125',
        ].join(' ')}
        style={{ fontSize: vertical ? 'clamp(10px, 3.3cqw, 13px)' : 'clamp(10px, 1.5cqw, 14px)' }}
      >
        <span className={sideways ? '[writing-mode:vertical-rl] rotate-180 whitespace-nowrap' : 'whitespace-nowrap'}>
          {visual.tone !== 'felt' && <span aria-hidden="true">♦ </span>}
          {visual.text}
        </span>
      </span>
    );
  } else {
    // Invisible hit zone on a border / intersection; a champagne marker shows on hover and focus.
    const bar = shape === 'point' ? 'h-2 w-2 rounded-full' : rect.w > rect.h ? 'h-[3px] w-3/5 rounded-full' : 'h-3/5 w-[3px] rounded-full';
    face = (
      <span
        className={[
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-champagne-pale opacity-0 shadow',
          disabled ? '' : 'group-hover:opacity-100',
          'group-focus-visible:opacity-100',
          bar,
        ].join(' ')}
      />
    );
  }

  return (
    <button
      type="button"
      data-bet-key={ls.spot.key}
      data-shape={shape}
      tabIndex={p.isActive ? 0 : -1}
      aria-label={accessibleName(p)}
      aria-disabled={disabled || undefined}
      className={[
        'group absolute m-0 touch-manipulation select-none border-0 p-0 [-webkit-touch-callout:none]',
        // Cells paint the 1px champagne lines (their face is inset by 1px); zones stay transparent.
        shape === 'cell' ? 'bg-champagne/40' : 'bg-transparent',
        rounded,
        LAYER_Z[ls.layer],
        'focus-visible:z-30 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-champagne-pale',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
      style={{
        left: pct(rect.x / layout.width),
        top: pct(rect.y / layout.height),
        width: pct(rect.w / layout.width),
        height: pct(rect.h / layout.height),
      }}
    >
      {face}
      {p.covered && (
        <span className="pointer-events-none absolute inset-px bg-champagne-light/25 ring-1 ring-inset ring-champagne-light" />
      )}
      {p.committedStake > 0 && (
        <span
          className={[
            'absolute z-10',
            p.draftStake > 0 ? '-translate-x-[80%] -translate-y-[80%]' : '-translate-x-1/2 -translate-y-1/2',
          ].join(' ')}
          style={chipAnchor(ls)}
        >
          <Chip amount={p.committedStake} variant="committed" size={p.chipPx} won={p.committedWon} />
        </span>
      )}
      {p.draftStake > 0 && (
        <span className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={chipAnchor(ls)}>
          <Chip amount={p.draftStake} variant="draft" size={p.chipPx} />
        </span>
      )}
    </button>
  );
});

// ───────────────────────────── table ─────────────────────────────

export function BettingTable(props: BettingTableProps & BettingTableExtraProps) {
  const { draft, committed, disabled, highlightNumber, onPlace, onRemove, className = '' } = props;

  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const measuredWidth = useContainerWidth(wrapRef, props.orientation === undefined);
  // Without a measurement (not laid out yet / no layout engine) default to the desktop layout.
  const orientation: Orientation =
    props.orientation ?? (measuredWidth > 0 ? orientationForWidth(measuredWidth) : 'horizontal');
  const layout = tableLayout(orientation);

  const [activeKey, setActiveKey] = useState<string>(layout.homeKey);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  // Latest callbacks for the long-press timer, which fires after the render that created it.
  const latest = useRef({ onPlace, onRemove, disabled });
  useLayoutEffect(() => {
    latest.current = { onPlace, onRemove, disabled };
  });

  const draftByKey = useMemo(() => {
    const m = new Map<string, Subunits>();
    for (const d of draft) m.set(d.spot.key, (m.get(d.spot.key) ?? 0) + d.stake);
    return m;
  }, [draft]);

  const committedByKey = useMemo(() => {
    const m = new Map<string, { stake: Subunits; won: boolean }>();
    for (const rb of committed) {
      const key = spotForRoundBet(rb)?.key ?? rb.key;
      const prev = m.get(key);
      // A win marker is only meaningful once the parent has revealed the result.
      const won = highlightNumber !== null && rb.won === true;
      m.set(key, { stake: (prev?.stake ?? 0) + rb.stake, won: (prev?.won ?? false) || won });
    }
    return m;
  }, [committed, highlightNumber]);

  const coveredSet = useMemo(
    () => new Set<number>(previewKey ? (layout.byKey.get(previewKey)?.covers ?? []) : []),
    [previewKey, layout],
  );

  // Chips take about half of a number cell's short side so a straight chip stays inside the
  // part of the cell that is not covered by the surrounding split/corner zones.
  const chipPx = useMemo(() => {
    if (measuredWidth <= 0) return 22;
    const boxPx = orientation === 'vertical' ? Math.min(measuredWidth, VERTICAL_MAX_WIDTH_PX) : measuredWidth;
    const cellPx = (boxPx / layout.width) * Math.min(layout.cell.w, layout.cell.h);
    return Math.round(Math.min(30, Math.max(18, cellPx * 0.5)));
  }, [measuredWidth, orientation, layout]);

  const spotOf = useCallback(
    (target: EventTarget | null): LaidOutSpot | null => {
      const el = target instanceof Element ? target.closest<HTMLElement>('[data-bet-key]') : null;
      const key = el?.dataset.betKey;
      return key ? (layout.byKey.get(key) ?? null) : null;
    },
    [layout],
  );

  const focusKey = useCallback((key: string) => {
    setActiveKey(key);
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-bet-key="${key}"]`);
    el?.focus();
  }, []);

  // ── long press (touch / pen) ──
  const press = useRef<{ key: string; timer: ReturnType<typeof setTimeout> | null; handled: boolean } | null>(null);
  const clearPressTimer = () => {
    if (press.current?.timer) {
      clearTimeout(press.current.timer);
      press.current.timer = null;
    }
  };
  useEffect(() => () => clearPressTimer(), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    clearPressTimer();
    press.current = null;
    const ls = spotOf(e.target);
    if (!ls || e.pointerType === 'mouse' || disabled) return;
    const state = { key: ls.spot.key, timer: null as ReturnType<typeof setTimeout> | null, handled: false };
    state.timer = setTimeout(() => {
      state.timer = null;
      if (latest.current.disabled) return;
      state.handled = true;
      latest.current.onRemove(ls.spot);
    }, LONG_PRESS_MS);
    press.current = state;
  };
  const endPress = () => clearPressTimer();

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const ls = spotOf(e.target);
    if (!ls) return;
    setActiveKey(ls.spot.key);
    if (press.current?.handled && press.current.key === ls.spot.key) {
      press.current = null; // the long press already removed a chip
      return;
    }
    if (disabled) return;
    if (e.shiftKey) onRemove(ls.spot);
    else onPlace(ls.spot);
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const ls = spotOf(e.target);
    if (!ls || disabled) return;
    e.preventDefault();
    const p = press.current;
    if (p && p.key === ls.spot.key) {
      clearPressTimer();
      if (p.handled) return; // long-press timer already removed a chip for this press
      p.handled = true;
    }
    onRemove(ls.spot);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ls = spotOf(e.target);
    if (!ls) return;
    let next: string | null = null;
    const dir = ARROWS[e.key];
    if (dir) next = neighborInDirection(layout, ls.spot.key, dir);
    else if (e.key === 'Home') next = layout.homeKey;
    else if (e.key === 'End') next = layout.endKey;
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (!disabled) onRemove(ls.spot);
      return;
    } else return; // Enter / Space activate the button natively → onClick → onPlace
    e.preventDefault();
    if (next) focusKey(next);
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const ls = spotOf(e.target);
    if (!ls) return;
    setActiveKey(ls.spot.key);
    setPreviewKey(ls.spot.key);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!gridRef.current?.contains(e.relatedTarget as Node | null)) setPreviewKey(null);
  };
  const onPointerOver = (e: PointerEvent<HTMLDivElement>) => {
    const ls = spotOf(e.target);
    const key = ls?.spot.key ?? null;
    if (press.current && press.current.key !== key) clearPressTimer(); // finger slid off the spot
    setPreviewKey((prev) => (prev === key ? prev : key));
  };

  const helpId = useId();
  const vertical = orientation === 'vertical';
  const active = layout.byKey.has(activeKey) ? activeKey : layout.homeKey;
  const hasCommitted = committedByKey.size > 0;

  return (
    <div ref={wrapRef} className={`w-full ${className}`} data-orientation={orientation}>
      <div
        className={[
          'mx-auto flex w-full flex-col gap-2 rounded-xl bg-felt-dark/80 p-1.5 shadow-felt',
          disabled ? 'opacity-95' : '',
        ].join(' ')}
        style={vertical ? { maxWidth: VERTICAL_MAX_WIDTH_PX } : undefined}
      >
        <div
          ref={gridRef}
          role="group"
          aria-label="European roulette betting table"
          aria-describedby={helpId}
          aria-disabled={disabled || undefined}
          className="relative w-full select-none overflow-visible rounded-md"
          style={{ aspectRatio: `${layout.width} / ${layout.height}`, containerType: 'inline-size' }}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onPointerDown={onPointerDown}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onPointerOver={onPointerOver}
          onPointerLeave={() => {
            endPress();
            setPreviewKey(null);
          }}
        >
          {layout.spots.map((ls) => {
            const c = committedByKey.get(ls.spot.key);
            const n = ls.visual.kind === 'number' ? ls.visual.n : null;
            return (
              <SpotView
                key={ls.spot.key}
                ls={ls}
                layout={layout}
                draftStake={draftByKey.get(ls.spot.key) ?? 0}
                committedStake={c?.stake ?? 0}
                committedWon={c?.won ?? false}
                isActive={ls.spot.key === active}
                covered={n !== null && coveredSet.has(n)}
                isWinner={n !== null && n === highlightNumber}
                disabled={disabled}
                chipPx={chipPx}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pb-0.5 font-mono text-[11px] text-champagne-light/90">
          <p id={helpId} className="m-0">
            {disabled
              ? 'Table locked — bets cannot be changed right now.'
              : 'Tap to add a chip · Shift+click, right-click or long-press removes one · arrow keys move, Enter places, Delete removes.'}
          </p>
          <p className="m-0 flex items-center gap-3" aria-hidden="true">
            {(!disabled || draft.length > 0) && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-champagne" /> draft
              </span>
            )}
            {hasCommitted && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-secondary" /> committed
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export type { BetSpot };
export default BettingTable;
