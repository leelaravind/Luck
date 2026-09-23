import type { ReactNode } from 'react';

/** Neutral message for "nothing here yet" (never filled with invented sample data). */
export interface EmptyStateProps {
  readonly children: ReactNode;
  readonly onFelt?: boolean;
  readonly className?: string;
}

export function EmptyState({ children, onFelt = false, className = '' }: Readonly<EmptyStateProps>) {
  return (
    <p className={`m-0 text-xs italic ${onFelt ? 'text-champagne-light/70' : 'text-ink-muted'} ${className}`}>{children}</p>
  );
}

export default EmptyState;
