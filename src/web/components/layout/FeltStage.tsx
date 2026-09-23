import type { ReactNode } from 'react';

/**
 * Emerald felt area (Stitch "grand emerald casino table"): recent results | LARGE wheel | last round,
 * then the complete betting table and the apron control bar. Pure layout — content arrives via slots.
 */
export interface FeltStageProps {
  readonly status: ReactNode;
  readonly left: ReactNode;
  readonly wheel: ReactNode;
  readonly right: ReactNode;
  readonly table: ReactNode;
  readonly feedback?: ReactNode;
  readonly controls: ReactNode;
}

export function FeltStage({ status, left, wheel, right, table, feedback, controls }: Readonly<FeltStageProps>) {
  return (
    <div className="felt-surface relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl p-3 shadow-felt sm:p-4">
      {status}
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] lg:items-center">
        <div className="order-2 min-w-0 lg:order-1">{left}</div>
        <section aria-label="Roulette wheel" className="order-1 mx-auto w-full max-w-[26rem] min-w-0 lg:order-2 lg:max-w-[30rem]">
          {wheel}
        </section>
        <div className="order-3 min-w-0">{right}</div>
      </div>
      <section aria-label="Betting table" className="min-w-0">
        {table}
      </section>
      {feedback}
      <div className="min-w-0 border-t border-champagne/30 pt-2">{controls}</div>
    </div>
  );
}

export default FeltStage;
