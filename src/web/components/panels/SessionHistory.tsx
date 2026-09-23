import { FileSpreadsheet, FolderOpen, Download } from 'lucide-react';
import type { ProviderStatus, SessionInfo, Subunits } from '../../../shared/contracts';
import { END_REASON_LABEL, MODE_LABEL, SESSION_STATUS_LABEL } from '../../copy';
import { formatCredits, formatDateTime, playerLabel } from '../../state/format';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';

/** All sessions stored on this machine, with exports (GET /api/sessions/:id/export, no secrets). */
export interface SessionHistoryProps {
  readonly sessions: readonly SessionInfo[];
  readonly providers: readonly ProviderStatus[];
  readonly selectedId: string | null;
  /** Revealed balance for the selected session (hides a result that is still spinning). */
  readonly selectedBalance: Subunits | null;
  readonly exportUrl: (id: string, format: 'json' | 'csv') => string;
  readonly onOpen: (id: string) => void;
}

export function SessionHistory({ sessions, providers, selectedId, selectedBalance, exportUrl, onOpen }: Readonly<SessionHistoryProps>) {
  if (!sessions.length) return <EmptyState>No sessions yet. Create one with “New session”.</EmptyState>;
  const sorted = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ul className="m-0 flex max-h-80 list-none flex-col gap-1.5 overflow-y-auto p-0">
      {sorted.map((s) => {
        const current = s.id === selectedId;
        const balance = current && selectedBalance !== null ? selectedBalance : s.balance;
        return (
          <li
            key={s.id}
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${current ? 'border-primary bg-primary-soft/40' : 'border-hairline bg-card'}`}
          >
            <div className="min-w-0 flex-1">
              <p className="m-0 flex flex-wrap items-center gap-1.5">
                <span className="truncate font-semibold text-ink">{s.name}</span>
                <Badge tone="neutral">{MODE_LABEL[s.mode]}</Badge>
                <Badge tone={s.status === 'running' ? 'primary' : s.status === 'completed' || s.status === 'stopped' ? 'neutral' : 'secondary'}>
                  {SESSION_STATUS_LABEL[s.status]}
                </Badge>
                {current ? <Badge tone="success">Open</Badge> : null}
              </p>
              <p className="m-0 mt-0.5 truncate text-ink-muted">
                {playerLabel(s.player, providers)} · {s.roundsPlayed} round{s.roundsPlayed === 1 ? '' : 's'} ·{' '}
                <span className="tnum font-mono">{formatCredits(balance)}</span> · {formatDateTime(s.createdAt)}
                {s.endReason ? ` · ${END_REASON_LABEL[s.endReason]}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <a
                href={exportUrl(s.id, 'json')}
                download
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline bg-card px-2 text-ink hover:bg-ivory-deep"
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                Export JSON<span className="sr-only"> for {s.name}</span>
              </a>
              <a
                href={exportUrl(s.id, 'csv')}
                download
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline bg-card px-2 text-ink hover:bg-ivory-deep"
              >
                <FileSpreadsheet aria-hidden="true" className="h-3.5 w-3.5" />
                Export CSV<span className="sr-only"> for {s.name}</span>
              </a>
              {current ? null : (
                <Button size="sm" variant="primary" icon={<FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />} onClick={() => onOpen(s.id)}>
                  Open<span className="sr-only"> {s.name}</span>
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default SessionHistory;
