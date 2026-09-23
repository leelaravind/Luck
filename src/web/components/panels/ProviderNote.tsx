import { COPY } from '../../copy';

/**
 * DecisionRecord.providerNote: a factual note from the provider ADAPTER (e.g. "conversation … turn 2
 * (resumed)", Laya top labels / routing). Labelled so it is never mistaken for model output.
 */
export interface ProviderNoteProps {
  readonly note: string | null | undefined;
  /** Compact single-line style for the decisions log. */
  readonly compact?: boolean;
}

export function ProviderNote({ note, compact = false }: Readonly<ProviderNoteProps>) {
  const text = note?.trim();
  if (!text) return null;
  if (compact) {
    return (
      <p className="m-0 break-words text-ink-soft" title={COPY.providerNoteHint}>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{COPY.providerNoteTitle}: </span>
        <span className="font-mono text-[11px]">{text}</span>
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-hairline bg-card-muted px-2 py-1.5" title={COPY.providerNoteHint}>
      <p className="m-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{COPY.providerNoteTitle}</p>
      <p className="m-0 mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-ink-soft">{text}</p>
    </div>
  );
}

export default ProviderNote;
