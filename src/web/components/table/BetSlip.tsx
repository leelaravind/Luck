/**
 * OWNER: betting-table agent (A5). Draft bet slip for manual play: each draft bet with its stake,
 * a remove button, the total, the LOCAL preview of the shared rules, and the server's error.
 * The preview is feedback only; the server re-validates every bet when the round is submitted.
 */
import { X } from 'lucide-react';
import { formatCredits } from '../../../shared/money';
import type { Subunits } from '../../../shared/contracts';
import type { BetSpot, DraftBet } from '../../contracts';
import type { DraftPreview } from './useBetDraft';

export interface BetSlipProps {
  readonly draft: readonly DraftBet[];
  readonly total: Subunits;
  readonly preview: DraftPreview;
  /** Last error returned by the server for a submitted slip (authoritative), or null. */
  readonly serverError?: string | null;
  /** Remove this bet from the draft (the parent decides: whole stack or last chip). */
  readonly onRemove: (spot: BetSpot) => void;
  /** Disable remove buttons (round in flight / session ended). */
  readonly disabled?: boolean;
  readonly className?: string;
}

export function BetSlip({ draft, total, preview, serverError = null, onRemove, disabled = false, className = '' }: BetSlipProps) {
  const count = draft.length;
  return (
    <section
      aria-label="Bet slip"
      className={`flex flex-col gap-2 rounded-card border border-hairline bg-card p-3 text-ink shadow-card ${className}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold tracking-tight">Bet slip</h3>
        <span className="font-mono text-[11px] uppercase tracking-wide text-ink-muted">
          {count === 0 ? 'empty' : `${count} bet${count === 1 ? '' : 's'} · draft`}
        </span>
      </header>

      {count === 0 ? (
        <p className="m-0 text-xs text-ink-muted">No chips placed yet. Pick a chip value and tap a spot on the table.</p>
      ) : (
        <ul className="m-0 flex max-h-56 list-none flex-col divide-y divide-hairline overflow-y-auto p-0">
          {draft.map(({ spot, stake }) => (
            <li key={spot.key} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{spot.label}</span>
                <span className="block font-mono text-[11px] text-ink-muted">pays {spot.payout} to 1</span>
              </span>
              <span className="tnum font-mono text-sm font-semibold">{formatCredits(stake)}</span>
              <button
                type="button"
                onClick={() => onRemove(spot)}
                disabled={disabled}
                aria-label={`Remove ${spot.label} (${formatCredits(stake)})`}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-ivory-deep hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-baseline justify-between border-t border-hairline pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Total stake</span>
        <span className="tnum font-mono text-base font-bold">{formatCredits(total)}</span>
      </div>

      {count > 0 && (
        <p
          role="status"
          className={`m-0 rounded-lg px-2 py-1.5 text-xs ${preview.ok ? 'bg-success-soft text-ink' : 'bg-warning-soft text-ink'}`}
        >
          <span className="font-semibold">Preview: </span>
          {preview.ok ? 'within the rules and limits.' : (preview.message ?? 'this slip would be rejected.')}{' '}
          <span className="text-ink-muted">The server re-checks every bet when you spin.</span>
        </p>
      )}

      {serverError && (
        <p role="alert" className="m-0 rounded-lg bg-danger-soft px-2 py-1.5 text-xs text-danger-strong">
          <span className="font-semibold">Server rejected the bets: </span>
          {serverError}
        </p>
      )}
    </section>
  );
}

export default BetSlip;
