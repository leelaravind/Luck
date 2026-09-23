import type { ReactNode } from 'react';
import type { ProviderCapabilities, SessionMode, UsageRecord, UsageSummary } from '../../../shared/contracts';
import { COPY, COST_BASIS_LABEL, MISSING_REASON } from '../../copy';
import { formatInt, formatMs, formatTokensPerSec, formatUsdMicros } from '../../state/format';
import { Card } from '../common/Card';
import { EmptyState } from '../common/EmptyState';
import { Meter } from '../common/Meter';
import { Metric } from '../common/Metric';
import { NotReported } from '../common/NotReported';
import { RateLimitPanel } from './RateLimitPanel';

/**
 * Real model usage for the selected session (UsageSummary from the server + per-attempt UsageRecords).
 * Anything the provider did not report is shown as "Not reported" with the reason — never estimated.
 */
export interface UsagePanelProps {
  /** null = no session selected. */
  readonly mode: SessionMode | null;
  readonly capabilities: ProviderCapabilities | null;
  readonly usage: UsageSummary | null;
  readonly records: readonly UsageRecord[];
}

type TokenField = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens';

function anyReported(records: readonly UsageRecord[], field: TokenField): boolean {
  return records.some((r) => r[field] !== null);
}

function tokenValue(
  field: TokenField,
  usage: UsageSummary,
  records: readonly UsageRecord[],
  caps: ProviderCapabilities | null,
): ReactNode {
  if (usage.requests === 0) return <NotReported label={COPY.noValue} reason={MISSING_REASON.noRequests} />;
  if (caps && !caps.generatesText && (field === 'outputTokens' || field === 'reasoningTokens')) {
    return <NotReported label="N/A" reason="Classifier: produces no generated text, so there are no output tokens." />;
  }
  if (caps?.reportsTokenUsage === 'none') return <NotReported reason={MISSING_REASON.noTokenUsage} />;
  if (caps?.reportsTokenUsage === 'input-only' && field !== 'inputTokens') {
    return <NotReported reason={MISSING_REASON.inputOnly} />;
  }
  // Summaries sum known numbers only; if no attempt reported this field, the 0 would be a fabrication.
  if (records.length && !anyReported(records, field)) {
    return <NotReported reason="No request in this session reported this figure." />;
  }
  if (usage.unknownUsageRequests >= usage.requests) {
    return <NotReported reason="None of the requests in this session reported usage." />;
  }
  return formatInt(usage[field]);
}

export function UsagePanel({ mode, capabilities, usage, records }: Readonly<UsagePanelProps>) {
  if (!mode || !usage) {
    return (
      <Card title="Usage" level={2}>
        <EmptyState>Select or create a session to see usage.</EmptyState>
      </Card>
    );
  }
  if (mode !== 'ai') {
    return (
      <Card title="Usage" level={2}>
        <EmptyState>{mode === 'demo' ? 'Rule-based demo player — no model usage.' : MISSING_REASON.notAi}</EmptyState>
      </Card>
    );
  }

  const last = [...records].reverse().find((r) => r.outputTokensPerSec !== null) ?? null;
  const speedBasis = last ? (last.generationMs !== null ? 'generation' : 'end-to-end') : null;
  const partial = usage.unknownUsageRequests > 0 && usage.unknownUsageRequests < usage.requests;
  const local = capabilities?.local ?? usage.costBasis === 'local-no-charge';

  const latency = (v: number | null) =>
    v !== null ? (
      formatMs(v)
    ) : usage.requests === 0 ? (
      <NotReported label={COPY.noValue} reason={MISSING_REASON.noRequests} />
    ) : (
      <NotReported reason={MISSING_REASON.latencyUnknown} />
    );

  const cost: ReactNode = local ? (
    <span className="text-xs">{COPY.localNoCharge}</span>
  ) : usage.costBasis === 'unknown' && usage.costMicros === 0 ? (
    <NotReported reason={COST_BASIS_LABEL.unknown} />
  ) : (
    formatUsdMicros(usage.costMicros)
  );

  const budget = usage.budgetMicros;
  return (
    <Card title="Usage" level={2} meta={partial ? <span className="font-mono text-[10px] text-warning">partial</span> : null}>
      <dl className="m-0 grid grid-cols-2 gap-1.5">
        <Metric label="Requests" value={formatInt(usage.requests)} />
        <Metric label="Failed" value={formatInt(usage.failedRequests)} />
        <Metric
          label="Unknown usage"
          value={formatInt(usage.unknownUsageRequests)}
          hint={usage.unknownUsageRequests ? 'Attempts without reported usage' : undefined}
        />
        <Metric label="Input tokens" value={tokenValue('inputTokens', usage, records, capabilities)} />
        <Metric label="Output tokens" value={tokenValue('outputTokens', usage, records, capabilities)} />
        <Metric label="Cached read" value={tokenValue('cacheReadTokens', usage, records, capabilities)} />
        <Metric label="Cached write" value={tokenValue('cacheWriteTokens', usage, records, capabilities)} />
        {anyReported(records, 'reasoningTokens') ? (
          <Metric label="Reasoning tokens" value={tokenValue('reasoningTokens', usage, records, capabilities)} />
        ) : null}
        <Metric label="Last latency" value={latency(usage.lastLatencyMs)} />
        <Metric label="Avg latency" value={latency(usage.avgLatencyMs)} />
        <Metric
          className="col-span-2"
          label={speedBasis ? `Output speed (${speedBasis})` : 'Output speed'}
          value={
            usage.lastOutputTokensPerSec !== null ? (
              formatTokensPerSec(usage.lastOutputTokensPerSec)
            ) : (
              <NotReported
                label={usage.requests === 0 ? COPY.noValue : COPY.notReported}
                reason={usage.requests === 0 ? MISSING_REASON.noRequests : MISSING_REASON.speedUnknown}
              />
            )
          }
          hint={
            speedBasis === 'end-to-end'
              ? 'Output tokens ÷ full request time (includes network and prompt processing)'
              : speedBasis === 'generation'
                ? 'Output tokens ÷ provider-reported generation time'
                : undefined
          }
        />
        <Metric
          className="col-span-2"
          label="Est. cost"
          value={cost}
          hint={`${COST_BASIS_LABEL[usage.costBasis]}${usage.costIsPartial ? ' · partial: some costs unknown' : ''}`}
        />
      </dl>

      <div className="mt-2.5 flex flex-col gap-1">
        <h3 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted" title={COPY.appBudgetNote}>
          {COPY.appBudgetTitle}
        </h3>
        {local ? (
          <p className="m-0 text-xs text-ink-soft">Not applicable — {COPY.localNoCharge.toLowerCase()}</p>
        ) : budget === null ? (
          <p className="m-0 text-xs text-ink-soft" title={MISSING_REASON.budgetNone}>
            <span className="font-semibold text-ink">No app spending limit</span> — plays until the balance is exhausted or you press Stop.
          </p>
        ) : (
          <>
            <Meter
              label={COPY.appBudgetTitle}
              value={usage.costMicros}
              max={budget}
              valueText={`${formatUsdMicros(usage.costMicros)} of ${formatUsdMicros(budget)} used`}
            />
            <p className="tnum m-0 font-mono text-[11px] text-ink-soft">
              {formatUsdMicros(usage.costMicros)} of {formatUsdMicros(budget)}
              {usage.budgetRemainingMicros !== null ? ` · ${formatUsdMicros(usage.budgetRemainingMicros)} left` : ''}
            </p>
          </>
        )}
        <p className="m-0 text-[10px] leading-snug text-ink-muted">{COPY.appBudgetNote}</p>
      </div>

      <div className="mt-2.5">
        <RateLimitPanel rateLimit={usage.lastRateLimit} capabilities={capabilities} />
      </div>
    </Card>
  );
}

export default UsagePanel;
