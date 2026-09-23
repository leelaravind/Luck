import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { COPY } from '../../copy';
import type { PricingRow } from '../../hooks/useSettingsForm';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { TextField } from '../common/TextField';

/**
 * Pricing assumptions per provider:model (USD per million tokens). Used ONLY to estimate cost, always
 * labelled as an assumption; the user is responsible for checking current provider prices.
 * Rows for a built-in default key (row.builtIn, from AppSettings.builtInPricingKeys) ship with the app: they
 * can be edited (which saves your own value) but not removed. Every other row can be removed, whatever its
 * source; the save sends the removal explicitly (pricingRemove), so a removed row stays removed.
 */
export interface PricingEditorProps {
  readonly rows: readonly PricingRow[];
  readonly errors: Record<string, string>;
  readonly onChange: (key: string, field: 'input' | 'output' | 'cacheRead' | 'cacheWrite', value: string) => void;
  readonly onAdd: (key: string) => void;
  readonly onRemove: (key: string) => void;
  /** Drop the user's override of a built-in row on save (it returns to the built-in default). */
  readonly onReset?: (key: string) => void;
  /** Suggested key for the player being configured, e.g. "anthropic:<model>". */
  readonly suggestedKey: string | null;
}

function rowLabel(r: PricingRow): string {
  if (r.dirty) return 'edited';
  if (r.source === 'user') return 'your value';
  // A default assumption whose key is not (or no longer) a built-in default: removable like any other entry.
  return r.builtIn ? 'default assumption' : 'default assumption (not built in)';
}

export function PricingEditor({ rows, errors, onChange, onAdd, onRemove, onReset, suggestedKey }: Readonly<PricingEditorProps>) {
  const [newKey, setNewKey] = useState('');
  const add = (key: string) => {
    const k = key.trim();
    if (k) onAdd(k);
    setNewKey('');
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 flex items-center gap-2 text-xs text-warning">
        <Badge tone="warning">{COPY.pricingAssumption}</Badge>
      </p>
      {rows.length === 0 ? <p className="m-0 text-xs text-ink-muted">No pricing assumptions saved. Cost stays “unknown” without one.</p> : null}
      {rows.some((r) => r.builtIn) ? (
        <p className="m-0 text-[11px] text-ink-muted">
          Built-in default assumptions come with the app and cannot be removed; edit one to save your own value for that model,
          and “Reset to default” brings the built-in value back. Every other entry can be removed.
        </p>
      ) : null}
      {rows.map((r) => (
        <fieldset key={r.key} className="m-0 min-w-0 rounded-lg border border-hairline p-2">
          <legend className="flex items-center gap-1.5 px-1 font-mono text-[11px] font-semibold text-ink">
            {r.key}
            <Badge tone={r.dirty || r.source === 'user' ? 'secondary' : 'neutral'}>
              {rowLabel(r)}
            </Badge>
            {r.asOf && !r.dirty ? <span className="font-normal text-ink-muted">as of {r.asOf}</span> : null}
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <TextField label="Input $/MTok" mono value={r.input} onChange={(v) => onChange(r.key, 'input', v)} inputMode="decimal" />
            <TextField label="Output $/MTok" mono value={r.output} onChange={(v) => onChange(r.key, 'output', v)} inputMode="decimal" />
            <TextField label="Cache read $/MTok" mono value={r.cacheRead} onChange={(v) => onChange(r.key, 'cacheRead', v)} inputMode="decimal" />
            <TextField label="Cache write $/MTok" mono value={r.cacheWrite} onChange={(v) => onChange(r.key, 'cacheWrite', v)} inputMode="decimal" />
          </div>
          {errors[r.key] ? <p className="m-0 mt-1 text-[11px] text-danger">{errors[r.key]}</p> : null}
          {r.builtIn && r.resetPending ? (
            <p className="m-0 mt-1 text-[11px] text-ink-muted">Resets to the built-in default when you save.</p>
          ) : null}
          {r.builtIn && r.source === 'user' && !r.resetPending && onReset ? (
            <Button
              size="sm"
              variant="quiet"
              className="mt-1"
              aria-label={`Reset ${r.key} to the built-in default`}
              icon={<X aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => onReset(r.key)}
            >
              Reset to default
            </Button>
          ) : null}
          {r.builtIn ? null : (
            <Button
              size="sm"
              variant="quiet"
              className="mt-1"
              aria-label={`Remove ${r.key}`}
              icon={<X aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => onRemove(r.key)}
            >
              Remove
            </Button>
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="Add assumption for provider:model"
          mono
          value={newKey}
          onChange={setNewKey}
          placeholder="provider:model"
          className="min-w-48 flex-1"
          spellCheck={false}
        />
        <Button size="md" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={() => add(newKey)} disabled={!newKey.trim()}>
          Add
        </Button>
        {suggestedKey && !rows.some((r) => r.key === suggestedKey) ? (
          <Button size="md" variant="quiet" onClick={() => add(suggestedKey)}>
            Add {suggestedKey}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default PricingEditor;
