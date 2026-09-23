import type { ReactNode } from 'react';

/** Label + value tile for telemetry (values in JetBrains Mono with tabular figures). */
export interface MetricProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly className?: string;
  /** Larger value for the one figure a panel leads with. */
  readonly emphasis?: boolean;
}

export function Metric({ label, value, hint, className = '', emphasis = false }: Readonly<MetricProps>) {
  return (
    <div className={`flex min-w-0 flex-col rounded-lg bg-card-muted px-2 py-1.5 shadow-inset-soft ${className}`}>
      <dt className="font-mono text-[11px] font-medium text-ink-muted">{label}</dt>
      <dd className={`tnum m-0 truncate font-mono font-semibold text-ink ${emphasis ? 'text-lg' : 'text-sm'}`}>{value}</dd>
      {hint ? <dd className="m-0 font-mono text-[10px] leading-tight text-ink-muted">{hint}</dd> : null}
    </div>
  );
}

export default Metric;
