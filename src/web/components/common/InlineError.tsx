import { CircleAlert, X } from 'lucide-react';

/** Error notice with the server's message and any listed validation details. */
export interface InlineErrorProps {
  readonly message: string;
  readonly code?: string;
  /** ApiErrorBody.error.details — shown when it is a list of strings or { errors: string[] }. */
  readonly details?: unknown;
  readonly onDismiss?: () => void;
  /** Dark variant for use on the felt. */
  readonly onFelt?: boolean;
  readonly className?: string;
}

export function detailLines(details: unknown): string[] {
  if (Array.isArray(details)) return details.filter((d): d is string => typeof d === 'string');
  if (details && typeof details === 'object') {
    const errors = (details as { errors?: unknown }).errors;
    if (Array.isArray(errors)) return errors.filter((d): d is string => typeof d === 'string');
    const issues = (details as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues
        .map((i) => (i && typeof i === 'object' && typeof (i as { message?: unknown }).message === 'string' ? (i as { message: string }).message : null))
        .filter((m): m is string => m !== null);
    }
  }
  return [];
}

export function InlineError({ message, code, details, onDismiss, onFelt = false, className = '' }: Readonly<InlineErrorProps>) {
  const lines = detailLines(details);
  const tone = onFelt
    ? 'border-pocket-red/60 bg-danger-strong/80 text-card'
    : 'border-danger/30 bg-danger-soft text-danger-strong';
  return (
    <div role="alert" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone} ${className}`}>
      <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">{message}</p>
        {lines.length ? (
          <ul className="m-0 mt-1 list-disc pl-4 text-xs">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
        {code ? <p className="m-0 mt-0.5 font-mono text-[10px] opacity-80">{code}</p> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error" className="rounded p-0.5 hover:bg-card/20">
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export default InlineError;
