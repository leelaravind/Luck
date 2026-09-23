import { Plus } from 'lucide-react';
import type { AiProviderKind, ConnectionTestResult, ProviderStatus, SessionInfo } from '../../../shared/contracts';
import { MODE_LABEL } from '../../copy';
import type { PlayerDraft } from '../../hooks/usePlayerDraft';
import { latestTest } from '../../state/availability';
import { playerLabel } from '../../state/format';
import type { BusyFlags, LastError } from '../../state/luckReducer';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { PlayerSelector } from './PlayerSelector';
import { ProviderConfigPanel } from './ProviderConfigPanel';

/**
 * Sidebar player section: who plays the open session (fixed at creation) and the player being prepared
 * for the next session, with provider configuration and a real connection test.
 */
export interface PlayerPanelProps {
  readonly session: SessionInfo | null;
  readonly providers: readonly ProviderStatus[];
  readonly providerTests: Partial<Record<AiProviderKind, ConnectionTestResult>>;
  readonly providerModels: Partial<Record<AiProviderKind, string[]>>;
  readonly player: PlayerDraft;
  readonly busy: BusyFlags;
  readonly providerError: LastError | null;
  readonly onDismissError: () => void;
  readonly onTest: () => void;
  readonly onLoadModels: () => void;
  readonly onNewSession: () => void;
}

export function PlayerPanel({
  session,
  providers,
  providerTests,
  providerModels,
  player,
  busy,
  providerError,
  onDismissError,
  onTest,
  onLoadModels,
  onNewSession,
}: Readonly<PlayerPanelProps>) {
  const provider = player.provider;
  return (
    <Card title="Player" level={2} meta={session ? <Badge tone="primary">{MODE_LABEL[session.mode]}</Badge> : null} bodyClassName="flex flex-col gap-3">
      {session ? (
        <div className="rounded-lg bg-card-muted px-2 py-1.5 shadow-inset-soft">
          <p className="m-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">This session</p>
          <p className="m-0 break-words text-sm font-semibold text-ink">{playerLabel(session.player, providers)}</p>
          <p className="m-0 text-[11px] text-ink-muted">A session’s player is fixed. Choose below and start a new session to switch.</p>
        </div>
      ) : null}

      <PlayerSelector
        legend="Player for a new session"
        providers={providers}
        providerTests={providerTests}
        value={player.kind}
        onChange={player.setKind}
      />

      {provider ? (
        <ProviderConfigPanel
          provider={provider}
          fields={player.fields}
          onField={player.setField}
          models={providerModels[provider.kind]}
          loadingModels={!!busy.models[provider.kind]}
          onLoadModels={onLoadModels}
          testing={!!busy.testing[provider.kind]}
          onTest={onTest}
          test={latestTest(provider, providerTests[provider.kind])}
          error={providerError && providerError.kind === provider.kind ? providerError : null}
          onDismissError={onDismissError}
        />
      ) : null}

      <Button variant="secondary" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={onNewSession}>
        New session with this player
      </Button>
    </Card>
  );
}

export default PlayerPanel;
