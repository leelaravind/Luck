/**
 * OWNER: betting-table agent (A5). Chip denomination picker (radio group with roving tabindex).
 */
import { useId, useRef, type KeyboardEvent } from 'react';
import { formatCredits } from '../../../shared/money';
import type { Subunits } from '../../../shared/contracts';
import { Chip } from '../table/Chip';

export interface ChipSelectorProps {
  readonly values: readonly Subunits[];
  readonly value: Subunits;
  readonly onChange: (v: Subunits) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function ChipSelector({ values, value, onChange, disabled = false, className = '' }: ChipSelectorProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const selectedIndex = values.indexOf(value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  if (values.length === 0) {
    return (
      <p className={`m-0 font-mono text-[11px] text-champagne-light ${className}`}>
        No chip denomination fits these session limits.
      </p>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    let next = -1;
    if (step !== 0) next = (focusIndex + step + values.length) % values.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = values.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(values[next]);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className={`flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2 ${className}`}>
      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-champagne" id={labelId}>
        Chip
      </span>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="flex flex-wrap items-center gap-0.5 rounded-2xl border border-white/10 bg-black/30 px-1 py-0.5 sm:gap-1 sm:px-1.5"
      >
        {values.map((v, i) => {
          const checked = v === value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`Chip ${formatCredits(v)}`}
              tabIndex={i === focusIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={[
                'inline-flex h-10 w-10 items-center justify-center rounded-full transition-transform',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-champagne-pale',
                'disabled:cursor-not-allowed disabled:opacity-40',
                checked ? 'scale-110 ring-2 ring-champagne-pale' : 'hover:scale-105',
              ].join(' ')}
            >
              <Chip amount={v} variant="denomination" size={32} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ChipSelector;
