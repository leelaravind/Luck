import { Dices, Plus, Settings } from 'lucide-react';
import type { SessionInfo } from '../../../shared/contracts';
import { COPY, SESSION_STATUS_LABEL } from '../../copy';
import type { ConnectionStatus } from '../../state/luckReducer';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { ConnectionIndicator } from '../common/ConnectionIndicator';
import { SelectField } from '../common/SelectField';

/** Top bar: brand, simulation badge, session picker + New session, settings, honest connection state. */
export interface AppHeaderProps {
  readonly sessions: readonly SessionInfo[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onNewSession: () => void;
  readonly onOpenSettings: () => void;
  /** A session is loaded, so a live event stream is expected. */
  readonly streaming: boolean;
  readonly connection: ConnectionStatus;
  readonly serverReachable: boolean | null;
  readonly version: string | null;
  readonly lastEventAt: string | null;
}

export function AppHeader({
  sessions,
  selectedId,
  onSelect,
  onNewSession,
  onOpenSettings,
  streaming,
  connection,
  serverReachable,
  version,
  lastEventAt,
}: Readonly<AppHeaderProps>) {
  const sorted = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const options = sorted.length
    ? sorted.map((s) => ({ value: s.id, label: `${s.name} · ${SESSION_STATUS_LABEL[s.status]}` }))
    : [{ value: '', label: COPY.noSessions, disabled: true }];
  return (
    <header className="z-40 border-b border-hairline bg-card/90 backdrop-blur-xl md:sticky md:top-0">
      <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 xl:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-felt text-champagne">
            <Dices className="h-4 w-4" />
          </span>
          <h1 className="m-0 truncate text-base font-semibold tracking-tight text-ink">{COPY.brand}</h1>
          {/* On phones the felt's status strip carries the "Virtual credits only" label instead. */}
          <span className="hidden sm:inline-flex">
            <Badge tone="neutral">{COPY.simulationBadge}</Badge>
          </span>
        </div>

        <nav aria-label="Sessions" className="order-last flex w-full min-w-0 items-center gap-2 lg:order-none lg:w-auto lg:flex-1 lg:justify-center">
          <SelectField
            label={COPY.sessionPicker}
            hideLabel
            value={selectedId ?? ''}
            options={selectedId ? options : [{ value: '', label: sorted.length ? 'Choose a session…' : COPY.noSessions, disabled: true }, ...(sorted.length ? options : [])]}
            onChange={(v) => v && onSelect(v)}
            className="min-w-0 flex-1 lg:max-w-sm"
          />
          <Button variant="primary" size="md" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={onNewSession}>
            {COPY.newSession}
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <ConnectionIndicator
            streaming={streaming}
            connection={connection}
            serverReachable={serverReachable}
            version={version}
            lastEventAt={lastEventAt}
          />
          <Button variant="quiet" size="md" onClick={onOpenSettings} aria-label="Open settings" title={COPY.settings}>
            <Settings aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}

export default AppHeader;
