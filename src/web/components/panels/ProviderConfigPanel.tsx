import { PlugZap, RefreshCw } from 'lucide-react';
import type { ConnectionTestResult, ProviderStatus } from '../../../shared/contracts';
import { PROVIDER_FIELDS, type PlayerDraftFields } from '../../hooks/usePlayerDraft';
import type { LastError } from '../../state/luckReducer';
import { Button } from '../common/Button';
import { InlineError } from '../common/InlineError';
import { SelectField } from '../common/SelectField';
import { TextField } from '../common/TextField';
import { CapabilityNotes } from './CapabilityNotes';
import { ConnectionTestResultView } from './ConnectionTestResultView';

/**
 * Non-secret configuration of one AI provider: model (listed from the provider when it can list models,
 * otherwise typed), endpoint where applicable, and a real connection test. API keys never appear here —
 * they live in the server's .env only.
 */
export interface ProviderConfigPanelProps {
  readonly provider: ProviderStatus;
  readonly fields: PlayerDraftFields;
  readonly onField: (field: keyof PlayerDraftFields, value: string) => void;
  /** Models from POST /api/providers/:kind/models (undefined = not loaded). */
  readonly models: readonly string[] | undefined;
  readonly loadingModels: boolean;
  readonly onLoadModels: () => void;
  readonly testing: boolean;
  readonly onTest: () => void;
  readonly test: ConnectionTestResult | null;
  readonly error: LastError | null;
  readonly onDismissError?: () => void;
  /** Hide the capability list (compact use in the new-session dialog). */
  readonly compact?: boolean;
}

export function ProviderConfigPanel({
  provider,
  fields,
  onField,
  models,
  loadingModels,
  onLoadModels,
  testing,
  onTest,
  test,
  error,
  onDismissError,
  compact = false,
}: Readonly<ProviderConfigPanelProps>) {
  const f = PROVIDER_FIELDS[provider.kind];
  const caps = provider.capabilities;
  const canList = caps.listsModels && provider.configured && provider.enabled;
  const listed = models && models.length > 0 ? models : null;
  const modelHint = provider.defaults.model
    ? `Server default: ${provider.defaults.model}`
    : 'Type the model id exactly as the provider expects it.';

  return (
    <div className="flex flex-col gap-2">
      {provider.issues.length ? (
        <ul className="m-0 list-none rounded-lg border border-warning/30 bg-warning-soft px-2 py-1.5 text-[11px] text-ink-soft">
          {provider.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}

      {f.model ? (
        listed ? (
          <SelectField
            label="Model"
            mono
            value={fields.model}
            onChange={(v) => onField('model', v)}
            options={[
              { value: '', label: 'Select a model…', disabled: true },
              ...listed.map((m) => ({ value: m, label: m })),
              ...(fields.model && !listed.includes(fields.model) ? [{ value: fields.model, label: `${fields.model} (typed)` }] : []),
            ]}
            hint={`${listed.length} model${listed.length === 1 ? '' : 's'} reported by the provider`}
          />
        ) : (
          <TextField
            label="Model"
            mono
            value={fields.model}
            onChange={(v) => onField('model', v)}
            placeholder="model id"
            spellCheck={false}
            autoComplete="off"
            hint={models && models.length === 0 ? 'The provider reported no models. Type one instead.' : modelHint}
          />
        )
      ) : null}

      {canList && f.model ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loadingModels ? 'motion-safe:animate-spin' : ''}`} />}
          onClick={onLoadModels}
          busy={loadingModels}
        >
          {listed ? 'Refresh model list' : 'Load models from provider'}
        </Button>
      ) : null}

      {f.baseUrl ? (
        <TextField
          label="Endpoint (base URL)"
          mono
          value={fields.baseUrl}
          onChange={(v) => onField('baseUrl', v)}
          placeholder={provider.defaults.baseUrl ?? 'http://127.0.0.1:…'}
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
        />
      ) : null}

      {f.checkpoint ? (
        <TextField
          label="Laya checkpoint"
          mono
          value={fields.layaCheckpoint}
          onChange={(v) => onField('layaCheckpoint', v)}
          placeholder={provider.defaults.layaCheckpoint ?? 'checkpoint name'}
          spellCheck={false}
          autoComplete="off"
        />
      ) : null}

      <Button
        size="sm"
        variant="secondary"
        icon={<PlugZap aria-hidden="true" className="h-3.5 w-3.5" />}
        onClick={onTest}
        busy={testing}
        disabled={!provider.configured || !provider.enabled}
      >
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      {test ? <ConnectionTestResultView result={test} /> : null}
      {error ? <InlineError message={error.message} code={error.code} details={error.details} onDismiss={onDismissError} /> : null}

      {compact ? null : <CapabilityNotes capabilities={caps} />}
    </div>
  );
}

export default ProviderConfigPanel;
