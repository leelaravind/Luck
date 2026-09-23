import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useDialog } from '../../hooks/useDialog';

/** Accessible modal: focus moves in, Tab is trapped, Escape and the backdrop close it. */
export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Dialog({ open, title, description, onClose, children, footer }: Readonly<DialogProps>) {
  const { ref, onKeyDown } = useDialog({ open, onClose });
  const titleId = useId();
  const descId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center">
      <div aria-hidden="true" className="fixed inset-0" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col rounded-card border border-hairline bg-card shadow-overlay"
      >
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-0.5 text-xs text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1 text-ink-muted hover:bg-ivory-deep hover:text-ink"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-hairline px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export default Dialog;
