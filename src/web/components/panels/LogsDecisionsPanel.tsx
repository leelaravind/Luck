import type { DecisionRecord, LogEntry, UsageRecord } from '../../../shared/contracts';
import { COPY, DECISION_STATUS_LABEL } from '../../copy';
import { betLabel, formatCredits, formatMs, formatTime, splitStatedStrategy } from '../../state/format';
import { NO_USAGE } from '../../state/usage';
import { Badge } from '../common/Badge';
import { EmptyState } from '../common/EmptyState';
import { DecisionUsage } from './DecisionUsage';
import { ProviderNote } from './ProviderNote';

/**
 * Session log lines and the decision history, as stored by the server (newest first). Each AI decision
 * shows the provider adapter's note and its per-attempt usage (tokens, cost with basis, latency).
 */
export interface LogsDecisionsPanelProps {
  readonly logs: readonly LogEntry[];
  readonly decisions: readonly DecisionRecord[];
  /** Usage records grouped by decisionId (attempts in order). */
  readonly usageByDecision: ReadonlyMap<string, readonly UsageRecord[]>;
  /** Items held back until the current spin is revealed. */
  readonly heldBack: number;
}

const LEVEL_TONE = { info: 'neutral', warn: 'warning', error: 'danger' } as const;

/** Only model players have usage; the demo player (rule-based) and manual play never do. */
const hasModelUsage = (d: DecisionRecord) => d.providerKind !== 'demo' && d.providerKind !== 'manual';

export function LogsDecisionsPanel({ logs, decisions, usageByDecision, heldBack }: Readonly<LogsDecisionsPanelProps>) {
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <section aria-labelledby="logs-title" className="min-w-0">
        <h3 id="logs-title" className="m-0 mb-1.5 text-sm font-semibold text-ink">
          Session log
        </h3>
        {logs.length ? (
          <ol className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-lg border border-hairline bg-ivory-deep p-0 font-mono text-[11px]">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-2 border-b border-hairline/70 px-2 py-1 last:border-b-0">
                <time dateTime={l.createdAt} className="shrink-0 text-ink-muted">
                  {formatTime(l.createdAt)}
                </time>
                <Badge tone={LEVEL_TONE[l.level]}>{l.type}</Badge>
                <span className="min-w-0 break-words text-ink-soft">{l.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState>No log entries yet.</EmptyState>
        )}
      </section>
      <section aria-labelledby="decisions-title" className="min-w-0">
        <h3 id="decisions-title" className="m-0 mb-1.5 text-sm font-semibold text-ink">
          Decisions
        </h3>
        {decisions.length ? (
          <ol className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-lg border border-hairline p-0 text-xs">
            {decisions.map((d) => (
              <li key={d.id} className="flex flex-col gap-0.5 border-b border-hairline px-2 py-1.5 odd:bg-card even:bg-card-muted last:border-b-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-semibold text-ink">Round #{d.roundNumber}</span>
                  <Badge tone={d.status === 'accepted' ? 'success' : d.status === 'pending' ? 'secondary' : 'warning'}>
                    {DECISION_STATUS_LABEL[d.status]}
                  </Badge>
                  {d.action ? <span className="font-mono uppercase text-ink-soft">{d.action}</span> : null}
                  <span className="ml-auto font-mono text-[10px] text-ink-muted">
                    {d.latencyMs !== null ? formatMs(d.latencyMs) : '—'} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                  </span>
                </div>
                {d.bets?.length ? (
                  <p className="m-0 text-ink-soft">
                    {d.bets.map((b) => `${betLabel(b)} ${typeof b.stake === 'number' ? formatCredits(b.stake) : ''}`).join(' · ')}
                  </p>
                ) : null}
                {(() => {
                  const stated = splitStatedStrategy(d.explanation);
                  return (
                    <>
                      {stated.strategy ? (
                        <p className="m-0 text-ink" title={COPY.modelStrategyNote}>
                          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-secondary-strong">
                            Strategy (stated):{' '}
                          </span>
                          <span className="font-semibold">{stated.strategy}</span>
                        </p>
                      ) : null}
                      {stated.explanation ? <p className="m-0 break-words text-ink-soft">“{stated.explanation}”</p> : null}
                    </>
                  );
                })()}
                {d.validationErrors.length ? (
                  <p className="m-0 text-danger-strong">{d.validationErrors.join(' · ')}</p>
                ) : null}
                {d.errorMessage ? <p className="m-0 text-danger-strong">{d.errorMessage}</p> : null}
                <ProviderNote note={d.providerNote} compact />
                {hasModelUsage(d) ? (
                  <DecisionUsage records={usageByDecision.get(d.id) ?? NO_USAGE} decisionStatus={d.status} className="mt-0.5" />
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState>No decisions in this session.</EmptyState>
        )}
      </section>
      {heldBack > 0 ? (
        <p className="m-0 text-[11px] italic text-ink-muted lg:col-span-2">
          {heldBack} newer item{heldBack === 1 ? '' : 's'} will appear when the current spin is revealed.
        </p>
      ) : null}
    </div>
  );
}

export default LogsDecisionsPanel;
