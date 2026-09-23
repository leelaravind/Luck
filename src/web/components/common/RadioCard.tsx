import type { ReactNode } from 'react';

/** Radio input styled as a selectable row; the native radio stays keyboard-operable (arrow keys). */
export interface RadioCardProps<T extends string> {
  readonly name: string;
  readonly value: T;
  readonly checked: boolean;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Right-aligned extra content (badge). */
  readonly detail?: ReactNode;
  readonly disabled?: boolean;
}

export function RadioCard<T extends string>({
  name,
  value,
  checked,
  onChange,
  label,
  icon,
  detail,
  disabled = false,
}: Readonly<RadioCardProps<T>>) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${
        checked ? 'border-primary bg-primary-soft/60 text-ink' : 'border-hairline bg-card text-ink-soft hover:bg-ivory-deep'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      {icon ? (
        <span aria-hidden="true" className={checked ? 'text-primary' : 'text-ink-muted'}>
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="min-w-0 break-words font-medium">{label}</span>
        {detail}
      </span>
    </label>
  );
}

export default RadioCard;
