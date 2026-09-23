import type { LastError } from '../../state/luckReducer';
import { InlineError } from '../common/InlineError';

/**
 * Messages shown right next to the betting table: the server's validation error for the last Spin /
 * control request, and the client-side draft preview (labelled as a preview; the server decides).
 */
export interface TableFeedbackProps {
  readonly roundError: LastError | null;
  readonly controlError: LastError | null;
  readonly draftMessage: string | null;
  readonly onDismiss: () => void;
}

export function TableFeedback({ roundError, controlError, draftMessage, onDismiss }: Readonly<TableFeedbackProps>) {
  const err = roundError ?? controlError;
  if (!err && !draftMessage) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {err ? (
        <InlineError
          onFelt
          message={err.scope === 'round' ? `The server rejected these bets: ${err.message}` : err.message}
          code={err.code}
          details={err.details}
          onDismiss={onDismiss}
        />
      ) : null}
      {draftMessage ? (
        <p className="m-0 rounded-lg bg-felt-dark/60 px-3 py-1.5 text-xs text-champagne-light">
          <span className="font-semibold">Preview:</span> {draftMessage}
        </p>
      ) : null}
    </div>
  );
}

export default TableFeedback;
