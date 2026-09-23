/** Horizontal meter; the fill carries severity (primary → warning → danger), the track is a lighter step. */
export interface MeterProps {
  /** Accessible name. */
  readonly label: string;
  readonly value: number;
  readonly max: number;
  /** Human-readable value for assistive tech, e.g. "$0.04 of $0.25". */
  readonly valueText: string;
}

export function Meter({ label, value, max, valueText }: Readonly<MeterProps>) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const fill = ratio >= 0.9 ? 'bg-danger' : ratio >= 0.7 ? 'bg-warning' : 'bg-primary';
  const track = ratio >= 0.9 ? 'bg-danger-soft' : ratio >= 0.7 ? 'bg-warning-soft' : 'bg-primary-soft';
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={valueText}
      className={`h-1.5 w-full overflow-hidden rounded-full ${track}`}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

export default Meter;
