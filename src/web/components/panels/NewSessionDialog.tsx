import { Plus } from 'lucide-react';
import type {
  AiProviderKind,
  ConnectionTestResult,
  CreateSessionRequest,
  ProviderStatus,
} from '../../../shared/contracts';
import { COPY } from '../../copy';
import type { NewSessionForm } from '../../hooks/useNewSessionForm';
import { isAiKind, type PlayerDraft } from '../../hooks/usePlayerDraft';
import { latestTest } from '../../state/availability';
import type { BusyFlags, LastError } from '../../state/luckReducer';
import { Button } from '../common/Button';
import { Dialog } from '../common/Dialog';
import { InlineError } from '../common/InlineError';
import { TextField } from '../common/TextField';
import { LimitsEditor } from './LimitsEditor';
import { PlayerSelector } from './PlayerSelector';
import { ProviderConfigPanel } from './ProviderConfigPanel';

/** POST /api/sessions: name, player (shared with the sidebar's player draft) and limits. */
export interface NewSessionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly form: NewSessionForm;
  readonly player: PlayerDraft;
  readonly providers: readonly ProviderStatus[];
  readonly providerTests: Partial<Record<AiProviderKind, ConnectionTestResult>>;
  readonly providerModels: Partial<Record<AiProviderKind, string[]>>;
  readonly busy: BusyFlags;
  readonly error: LastError | null;
  readonly providerError: LastError | null;
  readonly onCreate: (req: CreateSessionRequest) => void;
  readonly onTest: () => void;
  readonly onLoadModels: () => void;
}

export function NewSessionDialog({
  open,
  onClose,
  form,
  player,
  providers,
  providerTests,
  providerModels,
  busy,
  error,
  providerError,
  onCreate,
  onTest,
  onLoadModels,
}: Readonly<NewSessionDialogProps>) {
  const provider = player.provider;
  const ai = isAiKind(player.kind);
  const paid = !!provider?.capabilities.paid;
  const noBudget = paid && form.limitsForm.limits !== null && form.limitsForm.limits.budgetMicros === null;
  const blocked = ai && (!provider || !provider.configured || !provider.enabled);
  const req = form.buildRequest(player.config);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New session"
      description={`${COPY.virtualOnly}. Nothing starts playing until you press Spin (manual) or Start (autonomous).`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Plus aria-hidden="true" className="h-4 w-4" />}
            busy={busy.creating}
            disabled={!req || blocked}
            onClick={() => req && onCreate(req)}
          >
            {busy.creating ? 'Creating…' : 'Create session'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="Session name" value={form.name} onChange={form.setName} placeholder="Optional" hint="Leave blank for an automatic name." />
        <div className="grid gap-3 md:grid-cols-2">
          <PlayerSelector providers={providers} providerTests={providerTests} value={player.kind} onChange={player.setKind} />
          <div className="flex min-w-0 flex-col gap-2">
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
                error={providerError}
                compact
              />
            ) : (
              <p className="m-0 text-xs text-ink-muted">
                {player.kind === 'demo'
                  ? 'The demo player follows fixed rules. It is not AI and needs no credentials.'
                  : 'You place bets on the table and press Spin.'}
              </p>
            )}
            {blocked ? <p className="m-0 text-xs text-danger">This provider is not available. See the issues above.</p> : null}
          </div>
        </div>
        <LimitsEditor
          values={form.limitsForm.values}
          errors={form.limitsForm.errors}
          onChange={form.limitsForm.setValue}
          showModelLimits={ai}
        />
        {noBudget ? (
          <p className="m-0 rounded-lg border border-warning/30 bg-warning-soft px-2 py-1.5 text-xs text-ink-soft">
            No app spending limit is set. Paid providers refuse to start without one.
          </p>
        ) : null}
        {error ? <InlineError message={error.message} code={error.code} details={error.details} /> : null}
      </div>
    </Dialog>
  );
}

export default NewSessionDialog;
