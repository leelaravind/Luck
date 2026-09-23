import type { ProviderCapabilities } from '../../../shared/contracts';
import { COPY } from '../../copy';

/** What this provider actually reports, straight from ProviderCapabilities (no claims added). */
export interface CapabilityNotesProps {
  readonly capabilities: ProviderCapabilities;
}

const TOKENS: Record<ProviderCapabilities['reportsTokenUsage'], string> = {
  full: 'Reports input and output tokens',
  'input-only': 'Reports input tokens only',
  none: 'Does not report token usage',
};

const QUOTA: Record<ProviderCapabilities['quotaInfo'], string> = {
  'rate-limit-headers': 'Rate-limit info from response headers',
  'rate-limit-events': 'Rate-limit events from the CLI',
  none: 'No quota / rate-limit information',
};

export function CapabilityNotes({ capabilities: c }: Readonly<CapabilityNotesProps>) {
  const facts = [
    c.local ? COPY.localNoCharge : c.paid ? 'Paid provider — app spending limit applies' : 'Remote provider',
    c.generatesText ? TOKENS[c.reportsTokenUsage] : 'Classifier — generates no text or output tokens',
    c.reportsCost ? 'Reports its own cost figure' : null,
    QUOTA[c.quotaInfo],
    c.structuredOutput ? 'Structured (JSON schema) output' : 'Free-text output, parsed strictly',
  ].filter((f): f is string => f !== null);
  return (
    <div className="flex flex-col gap-1">
      <h4 className="m-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Capabilities</h4>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] leading-snug text-ink-soft">
        {facts.map((f) => (
          <li key={f}>· {f}</li>
        ))}
        {c.notes.map((n) => (
          <li key={n} className="text-ink-muted">
            · {n}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default CapabilityNotes;
