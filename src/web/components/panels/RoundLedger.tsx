import type { RoundRecord } from '../../../shared/contracts';
import { COPY } from '../../copy';
import { formatCredits, pocketLabel } from '../../state/format';
import { EmptyState } from '../common/EmptyState';

/**
 * Every round of the session (newest first) with the server's settlement figures. Rounds whose result is
 * not revealed yet show "Spinning…" instead of their outcome; committed rounds show "In play".
 */
export interface RoundLedgerProps {
  readonly rounds: readonly RoundRecord[];
  /** Rounds with seq <= revealedSeq may show their result. */
  readonly revealedSeq: number;
  /** Total rounds the server reports (to flag a truncated list). */
  readonly totalRounds: number;
}

export function RoundLedger({ rounds, revealedSeq, totalRounds }: Readonly<RoundLedgerProps>) {
  if (!rounds.length) return <EmptyState>No rounds played in this session yet.</EmptyState>;
  const sorted = [...rounds].sort((a, b) => b.seq - a.seq);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-80 overflow-auto rounded-lg border border-hairline">
        <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
          <caption className="sr-only">Round ledger, newest first</caption>
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              <th scope="col" className="px-2 py-1.5 font-semibold">Round</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Bets</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Stake</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Result</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Returned</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Net</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const revealed = r.winningNumber !== null && r.seq <= revealedSeq && r.status === 'settled';
              const pending = r.winningNumber !== null && r.seq > revealedSeq;
              const placeholder = pending ? COPY.spinning : COPY.inPlay;
              return (
                <tr key={r.id} className="border-b border-hairline/70 odd:bg-card even:bg-card-muted">
                  <th scope="row" className="tnum px-2 py-1 font-mono font-semibold text-ink">
                    #{r.seq}
                  </th>
                  <td className="max-w-[18rem] px-2 py-1 text-ink-soft">
                    {r.bets.length ? r.bets.map((b) => `${b.label} ${formatCredits(b.stake)}`).join(' · ') : 'No bets'}
                  </td>
                  <td className="tnum px-2 py-1 text-right font-mono">{formatCredits(r.totalStake)}</td>
                  <td className="px-2 py-1 font-mono">
                    {revealed ? pocketLabel(r.winningNumber!) : <span className="italic text-ink-muted">{placeholder}</span>}
                  </td>
                  <td className="tnum px-2 py-1 text-right font-mono">
                    {revealed && r.totalReturned !== null ? formatCredits(r.totalReturned) : '—'}
                  </td>
                  <td
                    className={`tnum px-2 py-1 text-right font-mono font-semibold ${
                      revealed && r.net !== null ? (r.net > 0 ? 'text-success' : r.net < 0 ? 'text-danger' : 'text-ink') : 'text-ink-muted'
                    }`}
                  >
                    {revealed && r.net !== null ? formatCredits(r.net, { sign: true }) : '—'}
                  </td>
                  <td className="tnum px-2 py-1 text-right font-mono">
                    {revealed && r.balanceAfter !== null ? formatCredits(r.balanceAfter) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalRounds > rounds.length ? (
        <p className="m-0 text-[11px] text-ink-muted">
          Showing the latest {rounds.length} of {totalRounds} rounds. Export the session for the full ledger.
        </p>
      ) : null}
    </div>
  );
}

export default RoundLedger;
