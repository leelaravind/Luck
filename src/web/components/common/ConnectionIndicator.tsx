import { LoaderCircle, Radio, WifiOff } from 'lucide-react';
import type { ConnectionStatus } from '../../state/luckReducer';
import { formatTime } from '../../state/format';

/**
 * Honest server-connection indicator. Shows only what the browser actually knows:
 * the EventSource state for the open session, or the /api/health result when no stream is open.
 * No latency figure is shown because none is measured.
 */
export interface ConnectionIndicatorProps {
  /** true when a session is selected (a live stream is expected). */
  readonly streaming: boolean;
  readonly connection: ConnectionStatus;
  /** Result of the last /api/health check; null = not checked yet. */
  readonly serverReachable: boolean | null;
  readonly version: string | null;
  readonly lastEventAt: string | null;
}

function describe(p: Readonly<ConnectionIndicatorProps>): { label: string; tone: 'ok' | 'wait' | 'bad'; title: string } {
  const version = p.version ? ` · server v${p.version}` : '';
  if (p.streaming) {
    const last = p.lastEventAt ? ` Last event received ${formatTime(p.lastEventAt)}.` : '';
    switch (p.connection) {
      case 'live':
        return { label: 'Live updates', tone: 'ok', title: `Event stream open${version}.${last}` };
      case 'connecting':
        return { label: 'Connecting…', tone: 'wait', title: 'Opening the event stream.' };
      case 'reconnecting':
        return { label: 'Reconnecting…', tone: 'wait', title: `Event stream lost; retrying.${last}` };
      case 'offline':
        return { label: 'Offline', tone: 'bad', title: `No event stream. Retrying automatically.${last}` };
    }
  }
  if (p.serverReachable === null) return { label: 'Checking server…', tone: 'wait', title: 'Contacting /api/health.' };
  return p.serverReachable
    ? { label: 'Server reachable', tone: 'ok', title: `/api/health answered${version}. No session stream open.` }
    : { label: 'Server unreachable', tone: 'bad', title: '/api/health did not answer. Is the Luck server running?' };
}

export function ConnectionIndicator(props: Readonly<ConnectionIndicatorProps>) {
  const d = describe(props);
  const Icon = d.tone === 'ok' ? Radio : d.tone === 'wait' ? LoaderCircle : WifiOff;
  const tone =
    d.tone === 'ok' ? 'text-success' : d.tone === 'wait' ? 'text-warning' : 'text-danger';
  return (
    <span
      role="status"
      title={d.title}
      className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] font-medium text-ink-soft"
    >
      <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${tone} ${d.tone === 'wait' ? 'motion-safe:animate-spin' : ''}`} />
      <span>{d.label}</span>
      <span className="sr-only">. {d.title}</span>
    </span>
  );
}

export default ConnectionIndicator;
