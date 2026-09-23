import { useId } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** Labelled native select (keyboard and screen-reader friendly by default). */
export interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly mono?: boolean;
  /** Visually hide the label (still announced). */
  readonly hideLabel?: boolean;
  readonly className?: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  mono = false,
  hideLabel = false,
  className = '',
}: Readonly<SelectFieldProps>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-xs font-medium text-ink-soft'}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hintId}
        className={`h-8 w-full min-w-0 rounded-lg border border-hairline-strong bg-card px-2 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60 ${mono ? 'font-mono' : ''}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span id={hintId} className="text-[11px] leading-tight text-ink-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export default SelectField;
