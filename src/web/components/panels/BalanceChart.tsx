import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { RoundRecord, Subunits } from '../../../shared/contracts';
import { useElementWidth } from '../../hooks/useElementWidth';
import { formatCredits } from '../../state/format';
import { EmptyState } from '../common/EmptyState';

/**
 * Balance after each REVEALED round (single series, one axis). Crosshair + tooltip on hover and on
 * keyboard focus (←/→). The Round ledger tab is the table view of the same numbers.
 */
export interface BalanceChartProps {
  /** Revealed settled rounds (any order). */
  readonly rounds: readonly RoundRecord[];
  readonly startingBalance: Subunits;
}

interface Point {
  round: number;
  balance: Subunits;
  net: Subunits | null;
}

const HEIGHT = 220;
const M = { top: 14, right: 16, bottom: 34, left: 72 };

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** "V$ 1,000" for whole credits, full "V$ 1,000.50" otherwise. */
function axisCredits(v: Subunits): string {
  return v % 100 === 0 ? formatCredits(v).replace(/\.00$/, '') : formatCredits(v);
}

export function BalanceChart({ rounds, startingBalance }: Readonly<BalanceChartProps>) {
  const { ref, width } = useElementWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const descId = useId();

  const points: Point[] = useMemo(() => {
    const settled = rounds
      .filter((r) => r.status === 'settled' && r.balanceAfter !== null)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ round: r.seq, balance: r.balanceAfter!, net: r.net }));
    return [{ round: 0, balance: startingBalance, net: null }, ...settled];
  }, [rounds, startingBalance]);

  if (points.length < 2) {
    return <EmptyState>The chart appears after the first revealed round.</EmptyState>;
  }

  const innerW = Math.max(120, width - M.left - M.right);
  const innerH = HEIGHT - M.top - M.bottom;
  const balances = points.map((p) => p.balance);
  const minB = Math.min(...balances);
  const maxB = Math.max(...balances);
  const step = niceStep((maxB - minB || Math.max(100, maxB * 0.1)) / 4);
  const yMin = Math.floor(minB / step) * step;
  const yMax = Math.max(Math.ceil(maxB / step) * step, yMin + step);
  const lastRound = points[points.length - 1]!.round;

  const x = (round: number) => M.left + (lastRound === 0 ? 0 : (round / lastRound) * innerW);
  const y = (b: number) => M.top + innerH - ((b - yMin) / (yMax - yMin)) * innerH;

  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) yTicks.push(v);
  const xStep = Math.max(1, Math.ceil(lastRound / 6));
  const xTicks: number[] = [];
  for (let r = 0; r <= lastRound; r += xStep) xTicks.push(r);
  if (xTicks[xTicks.length - 1] !== lastRound) xTicks.push(lastRound);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.round).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(lastRound).toFixed(1)},${(M.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(M.top + innerH).toFixed(1)} Z`;

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(points[i]!.round) - px) < Math.abs(x(points[best]!.round) - px)) best = i;
    }
    return best;
  };
  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (box) setActive(nearest(e.clientX - box.left));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = active ?? points.length - 1;
      setActive(Math.min(points.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(points.length - 1);
    else if (e.key === 'Escape') setActive(null);
  };

  const last = points[points.length - 1]!;
  const a = active !== null ? points[active]! : null;
  const summary =
    `Balance after each revealed round, rounds 1 to ${lastRound}. Start ${formatCredits(startingBalance)}, ` +
    `latest ${formatCredits(last.balance)}, lowest ${formatCredits(minB)}, highest ${formatCredits(maxB)}. ` +
    'The Round ledger tab lists every value.';

  return (
    <div
      ref={ref}
      className="relative w-full min-w-0 rounded-lg focus-visible:outline-2"
      tabIndex={0}
      role="group"
      aria-label="Balance chart. Use left and right arrow keys to inspect rounds."
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      <svg width={innerW + M.left + M.right} height={HEIGHT} role="img" aria-labelledby={titleId} aria-describedby={descId} className="block">
        <title id={titleId}>Balance chart</title>
        <desc id={descId}>{summary}</desc>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + innerW} y1={y(v)} y2={y(v)} className="stroke-hairline" strokeWidth={1} />
            <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="tnum fill-ink-muted font-mono text-[10px]">
              {axisCredits(v)}
            </text>
          </g>
        ))}
        {xTicks.map((r) => (
          <text key={r} x={x(r)} y={M.top + innerH + 16} textAnchor="middle" className="tnum fill-ink-muted font-mono text-[10px]">
            {r}
          </text>
        ))}
        <text x={M.left + innerW / 2} y={HEIGHT - 4} textAnchor="middle" className="fill-ink-muted text-[10px]">
          Round
        </text>
        {startingBalance >= yMin && startingBalance <= yMax ? (
          <g>
            <line
              x1={M.left}
              x2={M.left + innerW}
              y1={y(startingBalance)}
              y2={y(startingBalance)}
              className="stroke-ink-muted/60"
              strokeWidth={1}
            />
            <text x={M.left + innerW} y={y(startingBalance) - 4} textAnchor="end" className="fill-ink-muted text-[10px]">
              Start
            </text>
          </g>
        ) : null}
        <path d={area} className="fill-primary/10" />
        <path d={line} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.round)} cy={y(last.balance)} r={4} className="fill-primary stroke-card" strokeWidth={2} />
        {a ? (
          <g aria-hidden="true">
            <line x1={x(a.round)} x2={x(a.round)} y1={M.top} y2={M.top + innerH} className="stroke-ink-muted" strokeWidth={1} />
            <circle cx={x(a.round)} cy={y(a.balance)} r={4} className="fill-primary stroke-card" strokeWidth={2} />
          </g>
        ) : null}
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      {a ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 rounded-lg border border-hairline bg-card px-2 py-1 text-xs shadow-overlay"
          style={{ left: Math.min(Math.max(0, x(a.round) - 70), innerW + M.left - 140), width: 140 }}
        >
          <p className="tnum m-0 font-mono text-sm font-semibold text-ink">{formatCredits(a.balance)}</p>
          <p className="m-0 text-ink-muted">
            {a.round === 0 ? 'Starting balance' : `After round #${a.round}`}
            {a.net !== null ? ` · net ${formatCredits(a.net, { sign: true })}` : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default BalanceChart;
