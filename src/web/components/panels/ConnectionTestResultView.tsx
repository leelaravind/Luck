import { CircleCheck, CircleX } from 'lucide-react';
import type { ConnectionTestResult } from '../../../shared/contracts';
import { formatMs, formatTime } from '../../state/format';
import { NotReported } from '../common/NotReported';

/** The real ConnectionTestResult returned by POST /api/providers/:kind/test — nothing added. */
export interface ConnectionTestResultViewProps {
  readonly result: ConnectionTestResult;
}

export function ConnectionTestResultView({ result }: Readonly<ConnectionTestResultViewProps>) {
  const Icon = result.ok ? CircleCheck : CircleX;
  return (
    <div
      className={`rounded-lg border px-2 py-1.5 text-xs ${result.ok ? 'border-success/30 bg-success-soft/50' : 'border-danger/30 bg-danger-soft/60'}`}
    >
      <p className={`m-0 flex items-center gap-1 font-semibold ${result.ok ? 'text-success' : 'text-danger-strong'}`}>
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {result.ok ? 'Connection test passed' : 'Connection test failed'}
        <span className="ml-auto font-mono text-[10px] font-normal text-ink-muted">{formatTime(result.testedAt)}</span>
      </p>
      <p className="m-0 mt-0.5 break-words text-ink-soft">{result.message}</p>
      <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px]">
        <dt className="text-ink-muted">Latency</dt>
        <dd className="m-0 text-ink">
          {result.latencyMs === null ? <NotReported reason="The test did not complete a timed request." /> : formatMs(result.latencyMs)}
        </dd>
        <dt className="text-ink-muted">Version</dt>
        <dd className="m-0 break-all text-ink">
          {result.version ? result.version : <NotReported reason="The provider did not report a version." />}
        </dd>
        {result.models ? (
          <>
            <dt className="text-ink-muted">Models</dt>
            <dd className="m-0 text-ink">{result.models.length}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export default ConnectionTestResultView;
