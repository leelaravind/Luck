import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'felt';

/** Monospaced status pill (DESIGN.md "Agent Status Chips"). Always carries text, never colour alone. */
export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  /** Tooltip explaining the status. */
  readonly title?: string;
  readonly dot?: boolean;
  readonly className?: string;
}

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-ivory-deep text-ink-soft border-hairline',
  primary: 'bg-primary-soft text-primary-strong border-primary-soft',
  secondary: 'bg-secondary-soft text-secondary-strong border-secondary-soft',
  success: 'bg-success-soft text-success border-success-soft',
  warning: 'bg-warning-soft text-warning border-warning-soft',
  danger: 'bg-danger-soft text-danger-strong border-danger-soft',
  felt: 'bg-felt-dark/60 text-champagne border-champagne/40',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-ink-muted',
  primary: 'bg-primary',
  secondary: 'bg-secondary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  felt: 'bg-champagne',
};

export function Badge({ tone = 'neutral', children, title, dot = false, className = '' }: Readonly<BadgeProps>) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold leading-4 tracking-wide ${TONE[tone]} ${className}`}
    >
      {dot ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} /> : null}
      {children}
    </span>
  );
}

export default Badge;
