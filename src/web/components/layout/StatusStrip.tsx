import { LoaderCircle } from 'lucide-react';
import type { SessionInfo } from '../../../shared/contracts';
import { COPY, END_REASON_LABEL, MODE_LABEL, PAUSE_REASON_LABEL, PHASE_LABEL, SESSION_STATUS_LABEL } from '../../copy';
import { formatDuration } from '../../state/format';
import { Badge, type BadgeTone } from '../common/Badge';

/** Real session status + phase + round number. While the wheel animates it says so (presentation only). */
export interface StatusStripProps {
  readonly session: SessionInfo;
  /** Server status message; the caller withholds it while a result is hidden (it may quote the result). */
  readonly message: string | null;
  /** Round being animated (result hidden). */
  readonly spinningSeq: number | null;
  /** Round committed but not settled. */
  readonly inPlaySeq: number | null;
  /** Latest revealed round. */
  readonly revealedSeq: number;
  readonly decisionInFlight: boolean;
}

const STATUS_TONE: Record<SessionInfo['status'], BadgeTone> = {
  ready: 'secondary',
  running: 'primary',
  pause_requested: 'warning',
  paused: 'warning',
  stop_requested: 'danger',
  stopped: 'neutral',
  completed: 'neutral',
};

export function StatusStrip({ session: s, message, spinningSeq, inPlaySeq, revealedSeq, decisionInFlight }: Readonly<StatusStripProps>) {
  const terminal = s.status === 'stopped' || s.status === 'completed';
  const phase =
    spinningSeq !== null
      ? `Round #${spinningSeq}: ${COPY.spinning}`
      : inPlaySeq !== null
        ? `Round #${inPlaySeq}: ${PHASE_LABEL[s.phase]}`
        : terminal
          ? `${revealedSeq} round${revealedSeq === 1 ? '' : 's'} played`
          : s.phase === 'requesting_decision' || decisionInFlight
            ? `Round #${revealedSeq + 1}: ${PHASE_LABEL.requesting_decision}`
            : `Next: round #${revealedSeq + 1}`;
  const reason = s.endReason ? END_REASON_LABEL[s.endReason] : s.pauseReason && s.status === 'paused' ? PAUSE_REASON_LABEL[s.pauseReason] : null;
  const busy = spinningSeq !== null || s.phase === 'requesting_decision' || decisionInFlight;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-champagne/30 bg-felt-dark/70 px-3 py-2 text-card shadow-raised"
      aria-label="Session status"
      role="group"
    >
      <Badge tone={STATUS_TONE[s.status]} dot>
        {SESSION_STATUS_LABEL[s.status]}
      </Badge>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-card">
        {busy ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-mint motion-safe:animate-spin" /> : null}
        <span className="min-w-0 truncate">{phase}</span>
      </span>
      {reason ? <span className="text-xs text-champagne-light">{reason}</span> : null}
      {message ? (
        <span className="min-w-0 truncate text-xs text-champagne-light/80" title={message}>
          {message}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-champagne-light/90">
        <span>{MODE_LABEL[s.mode]} session</span>
        {s.mode !== 'manual' ? <span>· runtime {formatDuration(s.runtimeMs)}</span> : null}
        <span aria-hidden="true">|</span>
        <span className="font-semibold text-champagne">{COPY.virtualOnly}</span>
      </span>
    </div>
  );
}

export default StatusStrip;
