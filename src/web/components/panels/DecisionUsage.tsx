import type { ReactNode } from 'react';
import type { DecisionStatus, UsageAttemptStatus, UsageRecord } from '../../../shared/contracts';
import { COPY, COST_BASIS_LABEL, COST_BASIS_SHORT, MISSING_REASON, USAGE_STATUS_LABEL } from '../../copy';
import { formatInt, formatMs, formatUsdMicros } from '../../state/format';
import { Badge, type BadgeTone } from '../common/Badge';
import { NotReported } from '../common/NotReported';

/**
 * Usage of ONE decision, attempt by attempt, exactly as the server recorded it (UsageRecord matched by
 * decisionId): input / output / cached tokens, cost with its basis, latency and the attempt status.
 * Anything the provider did not report is shown as "Not reported" — never estimated.
 */
export interface DecisionUsageProps {
  /** This decision's usage records, attempts in order (may be empty). */
  readonly records: readonly UsageRecord[];
  readonly decisionStatus: DecisionStatus;
  readonly className?: string;
}

const STATUS_TONE: Record<UsageAttemptStatus, BadgeTone> = {
  ok: 'success',
  error: 'danger',
  timeout: 'warning',
  rate_limited: 'warning',
  invalid_output: 'danger',
  cancelled: 'neutral',
  stale: 'neutral',
};

function tokens(value: number | null, known: boolean): ReactNode {
  if (value !== null) return formatInt(value);
  return (
    <NotReported reason={known ? 'The provider reported usage for this attempt, but not this figure.' : MISSING_REASON.attemptNoUsage} />
  );
}

function cost(r: UsageRecord): ReactNode {
  if (r.costBasis === 'local-no-charge') return <span title={COST_BASIS_LABEL[r.costBasis]}>{COPY.localNoCharge}</span>;
  if (r.costMicros === null) {
    return <NotReported reason={r.costBasis === 'unknown' ? MISSING_REASON.attemptNoCost : COST_BASIS_LABEL[r.costBasis]} />;
  }
  return (
    <span title={COST_BASIS_LABEL[r.costBasis]}>
      {formatUsdMicros(r.costMicros)} <span className="text-ink-muted">({COST_BASIS_SHORT[r.costBasis]})</span>
    </span>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tnum m-0 min-w-0 text-ink">{children}</dd>
    </div>
  );
}

export function DecisionUsage({ records, decisionStatus, className = '' }: Readonly<DecisionUsageProps>) {
  const title = (
    <p className="m-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{COPY.decisionUsageTitle}</p>
  );
  if (!records.length) {
    const empty =
      decisionStatus === 'pending' ? (
        <NotReported label="In flight" reason="The request has not completed yet." />
      ) : decisionStatus === 'blocked_budget' ? (
        <NotReported label="Not sent" reason={MISSING_REASON.decisionNotSent} />
      ) : (
        <NotReported reason={MISSING_REASON.decisionNoUsage} />
      );
    return (
      <div className={`flex min-w-0 flex-col gap-0.5 font-mono text-[11px] ${className}`}>
        {title}
        <p className="m-0">{empty}</p>
      </div>
    );
  }
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      {title}
      <ol className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[11px]">
        {records.map((r) => (
          <li key={r.id} className="flex min-w-0 flex-col gap-0.5 rounded-md bg-card-muted px-1.5 py-1 shadow-inset-soft">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink">Attempt {r.attempt}</span>
              <Badge tone={STATUS_TONE[r.status]}>{USAGE_STATUS_LABEL[r.status]}</Badge>
            </div>
            <dl className="m-0 flex flex-wrap gap-x-3 gap-y-0.5">
              <Pair label="In">{tokens(r.inputTokens, r.known)}</Pair>
              <Pair label="Out">{tokens(r.outputTokens, r.known)}</Pair>
              <Pair label="Cached">{tokens(r.cacheReadTokens, r.known)}</Pair>
              {r.cacheWriteTokens !== null ? <Pair label="Cache write">{formatInt(r.cacheWriteTokens)}</Pair> : null}
              {r.reasoningTokens !== null ? <Pair label="Reasoning">{formatInt(r.reasoningTokens)}</Pair> : null}
              <Pair label="Cost">{cost(r)}</Pair>
              <Pair label="Latency">
                {r.latencyMs !== null ? formatMs(r.latencyMs) : <NotReported reason={MISSING_REASON.latencyUnknown} />}
              </Pair>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default DecisionUsage;
