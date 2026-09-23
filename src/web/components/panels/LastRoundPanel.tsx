import type { RoundRecord } from '../../../shared/contracts';
import { colorOf } from '../../../shared/roulette';
import { COPY } from '../../copy';
import { formatCredits } from '../../state/format';
import { EmptyState } from '../common/EmptyState';
import { NumberChip } from '../common/NumberChip';

/**
 * The latest REVEALED round with the server's settlement figures: stake returned (stake handed back on
 * winning bets), winnings (profit), net round result and balance after. Values are shown, never computed.
 */
export interface LastRoundPanelProps {
  readonly round: RoundRecord | null;
  readonly spinningSeq: number | null;
}

interface RowProps {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}

function Row({ label, value, strong = false }: Readonly<RowProps>) {
  return (
    <>
      <dt className="text-champagne-light/70">{label}</dt>
      <dd className={`tnum m-0 text-right font-mono ${strong ? 'font-bold text-card' : 'text-champagne-pale'}`}>{value}</dd>
    </>
  );
}

export function LastRoundPanel({ round, spinningSeq }: Readonly<LastRoundPanelProps>) {
  const r = round;
  return (
    <section aria-labelledby="last-round-title" className="flex flex-col gap-2 rounded-xl bg-felt-dark/50 p-3 text-card shadow-inset-soft">
      <div className="flex items-center justify-between gap-2">
        <h2 id="last-round-title" className="m-0 font-mono text-[11px] font-bold uppercase tracking-wider text-champagne">
          Last round
        </h2>
        {r ? <span className="font-mono text-[10px] text-champagne-light/70">Round #{r.seq}</span> : null}
      </div>
      {spinningSeq !== null ? (
        <p className="m-0 font-mono text-[11px] text-champagne-light">
          Round #{spinningSeq}: {COPY.spinning} Result shown when the ball rests.
        </p>
      ) : null}
      {r && r.winningNumber !== null ? (
        <>
          <div className="flex items-center gap-2">
            <NumberChip number={r.winningNumber} size="md" />
            <span className="text-sm font-semibold capitalize text-card">{colorOf(r.winningNumber)}</span>
          </div>
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
            <Row label="Total stake" value={formatCredits(r.totalStake)} />
            <Row label="Stake returned" value={r.stakeReturned === null ? '—' : formatCredits(r.stakeReturned)} />
            <Row label="Winnings" value={r.winnings === null ? '—' : formatCredits(r.winnings)} />
            <Row label="Net" value={r.net === null ? '—' : formatCredits(r.net, { sign: true })} strong />
            <Row label="Balance after" value={r.balanceAfter === null ? '—' : formatCredits(r.balanceAfter)} />
          </dl>
        </>
      ) : (
        <EmptyState onFelt>No round revealed yet.</EmptyState>
      )}
    </section>
  );
}

export default LastRoundPanel;
