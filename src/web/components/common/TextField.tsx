import { useId, type InputHTMLAttributes } from 'react';

/** Labelled input with hint and error text wired to aria-describedby / aria-invalid. */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'className'> {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  /** Monospaced value (numbers, model ids, URLs). */
  readonly mono?: boolean;
  readonly className?: string;
}

export function TextField({ label, value, onChange, hint, error, mono = false, className = '', ...rest }: Readonly<TextFieldProps>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        className={`h-8 w-full min-w-0 rounded-lg border bg-card px-2 text-sm text-ink placeholder:text-ink-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${error ? 'border-danger' : 'border-hairline-strong'} ${mono ? 'tnum font-mono' : ''}`}
        {...rest}
      />
      {hint ? (
        <span id={hintId} className="text-[11px] leading-tight text-ink-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className="text-[11px] font-medium leading-tight text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export default TextField;
