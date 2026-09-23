import { Save } from 'lucide-react';
import type { AnimationSpeed, AppSettings, AppSettingsPatch } from '../../../shared/contracts';
import type { SettingsForm } from '../../hooks/useSettingsForm';
import type { LastError } from '../../state/luckReducer';
import { Button } from '../common/Button';
import { InlineError } from '../common/InlineError';
import { SelectField } from '../common/SelectField';
import { TextField } from '../common/TextField';
import { LimitsEditor } from './LimitsEditor';
import { PricingEditor } from './PricingEditor';

/**
 * App settings (PUT /api/settings): default limits for NEW sessions, presentation preferences, the pause
 * between autonomous rounds and pricing assumptions. The pause (AppSettings.roundPacingMs) is what sets how
 * often a model is asked for a decision; animation speed only changes the wheel.
 * The save sends only what was changed here (see useSettingsForm); the dashboard re-reads the settings from
 * the server whenever this panel is opened, so it does not show (and save over) an old copy.
 */
export interface SettingsPanelProps {
  readonly form: SettingsForm;
  readonly loaded: boolean;
  readonly saving: boolean;
  readonly error: LastError | null;
  readonly onSave: (patch: AppSettingsPatch) => void;
  readonly suggestedPricingKey: string | null;
}

const SPEED_OPTIONS: { value: AnimationSpeed; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
  { value: 'instant', label: 'Instant (no spin: ball placed at once)' },
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
            hint="Changes only the wheel animation. How often models are asked is set by the pause between autonomous rounds below."
          />
          <SelectField
            label="Reduce motion"
            value={form.reduceMotion}
            options={MOTION_OPTIONS}
            onChange={(v) => form.setReduceMotion(v as AppSettings['reduceMotion'])}
          />
        </div>
      </section>

      <section aria-labelledby="settings-pacing-title" className="flex flex-col gap-2">
        <h3 id="settings-pacing-title" className="m-0 text-sm font-semibold text-ink">
          Autonomous play
        </h3>
        <p className="m-0 text-xs text-ink-muted">
          How long the server waits after a round before asking the player (AI model or demo) for the next decision. This
          sets how often models are called: a shorter pause means more requests per minute. It applies to every autonomous
          session; the wheel animation speed above does not change it.
        </p>
        <TextField
          label="Pause between autonomous rounds (seconds)"
          mono
          inputMode="decimal"
          value={form.pacingSec}
          onChange={form.setPacingSec}
          error={form.pacingError}
          className="sm:max-w-xs"
          hint="0 to 600 seconds · default 7"
        />
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
          onReset={form.resetRow}
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
