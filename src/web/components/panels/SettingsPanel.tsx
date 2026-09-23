import { Save } from 'lucide-react';
import type { AnimationSpeed, AppSettings } from '../../../shared/contracts';
import type { SettingsForm } from '../../hooks/useSettingsForm';
import type { LastError } from '../../state/luckReducer';
import { Button } from '../common/Button';
import { InlineError } from '../common/InlineError';
import { SelectField } from '../common/SelectField';
import { LimitsEditor } from './LimitsEditor';
import { PricingEditor } from './PricingEditor';

/**
 * App settings (PUT /api/settings): default limits for NEW sessions, presentation preferences and pricing
 * assumptions. Animation speed is presentation only and never changes how often models are called.
 */
export interface SettingsPanelProps {
  readonly form: SettingsForm;
  readonly loaded: boolean;
  readonly saving: boolean;
  readonly error: LastError | null;
  readonly onSave: (patch: Partial<AppSettings>) => void;
  readonly suggestedPricingKey: string | null;
}

const SPEED_OPTIONS: { value: AnimationSpeed; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
  { value: 'instant', label: 'Instant (no spin animation)' },
];

const MOTION_OPTIONS: { value: AppSettings['reduceMotion']; label: string }[] = [
  { value: 'system', label: 'Follow system setting' },
  { value: 'on', label: 'On — no wheel animation' },
  { value: 'off', label: 'Off — always animate' },
];

export function SettingsPanel({ form, loaded, saving, error, onSave, suggestedPricingKey }: Readonly<SettingsPanelProps>) {
  if (!loaded) return <p className="m-0 text-xs text-ink-muted">Settings are loading from the server…</p>;
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.patch) onSave(form.patch);
      }}
    >
      <section aria-labelledby="settings-limits-title" className="flex flex-col gap-2">
        <h3 id="settings-limits-title" className="m-0 text-sm font-semibold text-ink">
          Default limits for new sessions
        </h3>
        <p className="m-0 text-xs text-ink-muted">Existing sessions keep the limits they were created with.</p>
        <LimitsEditor values={form.limitsForm.values} errors={form.limitsForm.errors} onChange={form.limitsForm.setValue} />
      </section>

      <section aria-labelledby="settings-display-title" className="flex flex-col gap-2">
        <h3 id="settings-display-title" className="m-0 text-sm font-semibold text-ink">
          Display
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SelectField
            label="Wheel animation speed"
            value={form.animationSpeed}
            options={SPEED_OPTIONS}
            onChange={(v) => form.setAnimationSpeed(v as AnimationSpeed)}
            hint="Presentation only — does not change how often a model is asked."
          />
          <SelectField
            label="Reduce motion"
            value={form.reduceMotion}
            options={MOTION_OPTIONS}
            onChange={(v) => form.setReduceMotion(v as AppSettings['reduceMotion'])}
          />
        </div>
      </section>

      <section aria-labelledby="settings-pricing-title" className="flex flex-col gap-2">
        <h3 id="settings-pricing-title" className="m-0 text-sm font-semibold text-ink">
          Pricing assumptions (estimated cost only)
        </h3>
        <PricingEditor
          rows={form.rows}
          errors={form.pricingErrors}
          onChange={form.updateRow}
          onAdd={form.addRow}
          onRemove={form.removeRow}
          suggestedKey={suggestedPricingKey}
        />
      </section>

      {error ? <InlineError message={error.message} code={error.code} details={error.details} /> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" icon={<Save aria-hidden="true" className="h-4 w-4" />} busy={saving} disabled={!form.patch}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        {!form.patch ? <span className="text-xs text-danger">Fix the highlighted fields to save.</span> : null}
      </div>
    </form>
  );
}

export default SettingsPanel;
