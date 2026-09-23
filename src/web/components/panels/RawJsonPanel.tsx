import type { DecisionRecord } from '../../../shared/contracts';
import { MAX_RAW_OUTPUT_CHARS } from '../../../shared/contracts';
import { DECISION_STATUS_LABEL } from '../../copy';
import { EmptyState } from '../common/EmptyState';

/** The last decision's raw provider output (as stored, truncated server-side) and its validation errors. */
export interface RawJsonPanelProps {
  readonly decision: DecisionRecord | null;
}

export function RawJsonPanel({ decision }: Readonly<RawJsonPanelProps>) {
  if (!decision) return <EmptyState>No model or demo decision in this session yet.</EmptyState>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-xs text-ink-soft">
        Round #{decision.roundNumber} · {DECISION_STATUS_LABEL[decision.status]}
        {decision.model ? ` · ${decision.model}` : ''} · stored raw output is capped at {MAX_RAW_OUTPUT_CHARS} characters.
      </p>
      <section aria-labelledby="raw-output-title" className="min-w-0">
        <h3 id="raw-output-title" className="m-0 mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Raw output
        </h3>
        {decision.rawOutput ? (
          <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-ivory-deep p-2 font-mono text-[11px] text-ink shadow-inset-soft">
            {decision.rawOutput}
          </pre>
        ) : (
          <EmptyState>The provider returned no text for this decision.</EmptyState>
        )}
      </section>
      <section aria-labelledby="raw-validation-title" className="min-w-0">
        <h3 id="raw-validation-title" className="m-0 mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Validation errors
        </h3>
        {decision.validationErrors.length ? (
          <ul className="m-0 list-disc pl-4 font-mono text-[11px] text-danger-strong">
            {decision.validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : (
          <EmptyState>None.</EmptyState>
        )}
      </section>
    </div>
  );
}

export default RawJsonPanel;
