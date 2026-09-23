import { Info } from 'lucide-react';
import { COPY } from '../../copy';

/**
 * Honest placeholder for a measurement the provider/server did not report.
 * The reason is available as a tooltip and to screen readers.
 */
export interface NotReportedProps {
  /** Why the value is missing (tooltip + screen-reader text). */
  readonly reason: string;
  /** Defaults to "Not reported"; use "—" for "nothing yet". */
  readonly label?: string;
  readonly className?: string;
}

export function NotReported({ reason, label = COPY.notReported, className = '' }: Readonly<NotReportedProps>) {
  return (
    <span title={reason} className={`inline-flex items-center gap-1 text-ink-muted ${className}`}>
      <span>{label}</span>
      <Info aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="sr-only">({reason})</span>
    </span>
  );
}

export default NotReported;
