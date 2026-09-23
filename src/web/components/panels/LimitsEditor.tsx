import { LIMIT_FIELD_COPY } from '../../copy';
import type { LimitField, LimitsErrors, LimitsValues } from '../../hooks/useLimitsForm';
import { TextField } from '../common/TextField';

/** Session limits form (credits as decimals, parsed to integer subunits by parseCredits). */
export interface LimitsEditorProps {
  readonly values: LimitsValues;
  readonly errors: LimitsErrors;
  readonly onChange: (field: LimitField, value: string) => void;
  /** Hide model-related limits (manual sessions do not call models). */
  readonly showModelLimits?: boolean;
}

const MONEY: readonly LimitField[] = ['startingBalance', 'minStake', 'stakeIncrement', 'maxStakePerBet', 'maxStakePerRound'];
const PLAY: readonly LimitField[] = ['maxBetsPerRound', 'maxRounds', 'maxRuntimeMin'];
const MODEL: readonly LimitField[] = [
  'budgetUsd',
  'maxOutputTokens',
  'decisionTimeoutSec',
  'maxRetries',
  'maxConsecutiveFailures',
  'historyWindow',
];

export function LimitsEditor({ values, errors, onChange, showModelLimits = true }: Readonly<LimitsEditorProps>) {
  const group = (title: string, fields: readonly LimitField[]) => (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{title}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <TextField
            key={f}
            label={LIMIT_FIELD_COPY[f].label}
            hint={LIMIT_FIELD_COPY[f].hint}
            value={values[f]}
            onChange={(v) => onChange(f, v)}
            error={errors[f]}
            mono
            inputMode="decimal"
            autoComplete="off"
          />
        ))}
      </div>
    </fieldset>
  );
  return (
    <div className="flex flex-col gap-3">
      {group('Credits (virtual)', MONEY)}
      {group('Rounds', PLAY)}
      {showModelLimits ? group('Model requests', MODEL) : null}
      {showModelLimits ? (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={values.allowModelStop === 'true'}
            onChange={(e) => onChange('allowModelStop', e.target.checked ? 'true' : 'false')}
          />
          <span>
            {LIMIT_FIELD_COPY.allowModelStop.label}
            <span className="block text-xs text-ink-muted">{LIMIT_FIELD_COPY.allowModelStop.hint}</span>
          </span>
        </label>
      ) : null}
    </div>
  );
}

export default LimitsEditor;
