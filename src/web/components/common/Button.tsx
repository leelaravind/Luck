import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

/** DESIGN.md buttons: teal primary, indigo secondary, white ghost. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
  readonly icon?: ReactNode;
  readonly busy?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-card hover:bg-primary-strong border-primary-strong/30',
  secondary: 'bg-secondary text-card hover:bg-secondary-strong border-secondary-strong/30',
  ghost: 'bg-card text-ink hover:bg-ivory-deep border-hairline',
  danger: 'bg-danger text-card hover:bg-danger-strong border-danger-strong/30',
  quiet: 'bg-transparent text-ink-soft hover:bg-ivory-deep hover:text-ink border-transparent',
};

const SIZE = { sm: 'h-7 px-2 text-xs gap-1', md: 'h-9 px-3 text-sm gap-1.5' } as const;

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  busy = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: Readonly<ButtonProps>) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export default Button;
