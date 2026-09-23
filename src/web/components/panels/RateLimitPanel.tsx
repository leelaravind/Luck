import type { ProviderCapabilities, RateLimitInfo } from '../../../shared/contracts';
import { COPY, MISSING_REASON } from '../../copy';
import { formatInt, formatTime } from '../../state/format';
import { NotReported } from '../common/NotReported';

/**
 * Provider-side quota / rate-limit information — ONLY what the provider actually sent
 * (response headers or CLI rate-limit events). Distinct from the app's own spending limit.
 */
export interface RateLimitPanelProps {
  readonly rateLimit: RateLimitInfo | null;
  readonly capabilities: ProviderCapabilities | null;
}

const SOURCE: Record<RateLimitInfo['source'], string> = {
  'response-headers': 'from response headers',
  'cli-rate-limit-event': 'from a CLI rate-limit event',
};

export function RateLimitPanel({ rateLimit, capabilities }: Readonly<RateLimitPanelProps>) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{COPY.providerQuotaTitle}</h3>
      {capabilities?.local ? (
        <p className="m-0 text-xs text-ink-soft">{COPY.localNoCharge}</p>
      ) : !rateLimit ? (
        <NotReported
          label={COPY.quotaNotReported}
          reason={capabilities?.quotaInfo === 'none' ? MISSING_REASON.quotaNever : MISSING_REASON.quota}
          className="text-xs"
        />
      ) : (
        <div className="flex flex-col gap-1">
          <p className="m-0 font-mono text-[10px] text-ink-muted">
            {SOURCE[rateLimit.source]} · {formatTime(rateLimit.capturedAt)}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rateLimit.entries.map((e, i) => (
              <li key={`${e.name}-${i}`} className="rounded-md bg-card-muted px-2 py-1 font-mono text-[11px] text-ink-soft">
                <span className="font-semibold text-ink">{e.name}</span>
                {e.remaining !== undefined && e.limit !== undefined ? (
                  <span> · {formatInt(e.remaining)} / {formatInt(e.limit)} remaining</span>
                ) : e.remaining !== undefined ? (
                  <span> · {formatInt(e.remaining)} remaining</span>
                ) : e.limit !== undefined ? (
                  <span> · limit {formatInt(e.limit)}</span>
                ) : null}
                {/* Shown exactly as reported (the unit is provider-defined). */}
                {e.utilization !== undefined ? <span> · utilization {e.utilization}</span> : null}
                {e.status ? <span> · {e.status}</span> : null}
                {e.resetAt ? <span> · resets {formatTime(e.resetAt)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default RateLimitPanel;
