import type { RoundRecord } from '../../../shared/contracts';
import { COPY } from '../../copy';
import { EmptyState } from '../common/EmptyState';
import { NumberChip } from '../common/NumberChip';

/**
 * Revealed results only, newest first, each labelled with its round number so an old result is never
 * mistaken for the current spin. No hot/cold or "sector density" statistics: past spins do not predict
 * future ones on a fair wheel.
 */
export interface RecentResultsPanelProps {
  /** Revealed settled rounds, newest first. */
  readonly rounds: readonly RoundRecord[];
  /** Round currently spinning (its result is hidden). */
  readonly spinningSeq: number | null;
  readonly limit?: number;
}

export function RecentResultsPanel({ rounds, spinningSeq, limit = 10 }: Readonly<RecentResultsPanelProps>) {
  const shown = rounds.filter((r) => r.winningNumber !== null).slice(0, limit);
  return (
    <section aria-labelledby="recent-results-title" className="flex flex-col gap-2 rounded-xl bg-felt-dark/50 p-3 text-card shadow-inset-soft">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recent-results-title" className="m-0 font-mono text-[11px] font-bold uppercase tracking-wider text-champagne">
          Recent results
        </h2>
        <span className="font-mono text-[10px] text-champagne-light/70">
          {shown.length ? `Last ${shown.length}` : ''}
        </span>
      </div>
      {spinningSeq !== null ? (
        <p className="m-0 font-mono text-[11px] text-champagne-light" aria-hidden="true">
          Round #{spinningSeq}: {COPY.spinning}
        </p>
      ) : null}
      {shown.length ? (
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Revealed results, newest first">
          {shown.map((r, i) => (
            <li key={r.id} aria-label={`Round ${r.seq}: ${r.winningNumber}`}>
              <NumberChip number={r.winningNumber!} round={r.seq} size="sm" latest={i === 0 && spinningSeq === null} />
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState onFelt>No revealed results yet.</EmptyState>
      )}
      <p className="m-0 text-[10px] leading-snug text-champagne-light/60">{COPY.historyNotice}</p>
    </section>
  );
}

export default RecentResultsPanel;
