import type { DecisionRecord, SessionMode } from '../../../shared/contracts';
import { COPY, DECISION_STATUS_LABEL, MISSING_REASON } from '../../copy';
import { betLabel, formatCredits, formatMs } from '../../state/format';
import { Badge, type BadgeTone } from '../common/Badge';
import { Card } from '../common/Card';
import { EmptyState } from '../common/EmptyState';
import { NotReported } from '../common/NotReported';

/**
 * The latest decision exactly as recorded by the server: action, proposed bets, the player's own
 * explanation (clearly marked unverified), validation result and latency. No confidence / EV / Kelly
 * figures — none are measured.
 */
export interface LatestDecisionCardProps {
  readonly decision: DecisionRecord | null;
  readonly mode: SessionMode | null;
}

const STATUS_TONE: Record<DecisionRecord['status'], BadgeTone> = {
  pending: 'secondary',
  accepted: 'success',
  invalid: 'danger',
  failed: 'danger',
  stale: 'neutral',
  cancelled: 'neutral',
  interrupted: 'warning',
  blocked_budget: 'warning',
};

export function LatestDecisionCard({ decision, mode }: Readonly<LatestDecisionCardProps>) {
  if (mode === 'manual' || mode === null) return null;
  const d = decision;
  return (
    <Card
      title="Latest decision"
      level={2}
      meta={d ? <Badge tone="felt">Round #{d.roundNumber}</Badge> : null}
      bodyClassName="flex flex-col gap-2"
    >
      {!d ? (
        <EmptyState>{MISSING_REASON.latestDecisionNone}</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[d.status]} dot>
              {DECISION_STATUS_LABEL[d.status]}
            </Badge>
            {d.action ? <Badge tone="primary">{d.action.toUpperCase()}</Badge> : null}
            {mode === 'demo' ? <Badge tone="neutral">{COPY.demoTagline}</Badge> : null}
          </div>

          {d.action === 'bet' && d.bets?.length ? (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm font-semibold text-primary-strong">
              {d.bets.map((b, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{betLabel(b)}</span>
                  <span className="tnum shrink-0 font-mono">
                    {typeof b.stake === 'number' ? formatCredits(b.stake) : String(b.stake)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {d.explanation ? (
            <figure className="m-0 rounded-lg bg-ivory-deep p-2 shadow-inset-soft">
              <figcaption className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted" title={COPY.modelExplanationNote}>
                {mode === 'demo' ? 'Demo player’s rule description' : COPY.modelExplanationTitle}
              </figcaption>
              <blockquote className="m-0 mt-1 break-words font-mono text-xs leading-relaxed text-ink-soft">“{d.explanation}”</blockquote>
            </figure>
          ) : null}

          {d.validationErrors.length ? (
            <div className="rounded-lg border border-danger/30 bg-danger-soft px-2 py-1.5">
              <p className="m-0 text-[11px] font-semibold text-danger-strong">Validation errors</p>
              <ul className="m-0 list-disc pl-4 text-[11px] text-danger-strong">
                {d.validationErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {d.errorMessage ? (
            <p className="m-0 text-[11px] text-danger-strong">
              {d.errorCode ? <span className="font-mono">[{d.errorCode}] </span> : null}
              {d.errorMessage}
            </p>
          ) : null}

          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px] text-ink-muted">
            <dt>Latency</dt>
            <dd className="m-0 text-ink">
              {d.latencyMs !== null ? (
                formatMs(d.latencyMs)
              ) : (
                <NotReported
                  label={d.status === 'pending' ? 'In flight' : COPY.notReported}
                  reason={d.status === 'pending' ? 'The request has not completed yet.' : MISSING_REASON.latencyUnknown}
                />
              )}
            </dd>
            <dt>Attempts</dt>
            <dd className="m-0 text-ink">{d.attempts}</dd>
            {d.model ? (
              <>
                <dt>Model</dt>
                <dd className="m-0 truncate text-ink">{d.model}</dd>
              </>
            ) : null}
          </dl>
        </>
      )}
    </Card>
  );
}

export default LatestDecisionCard;
