/**
 * OWNER: betting-table agent (A5). Casino chip face, used on the table (draft / committed stacks)
 * and in the chip selector. Presentational only; amounts are integer subunits.
 */
import { formatCredits } from '../../../shared/money';
import type { Subunits } from '../../../shared/contracts';
import { chipLabel } from './chipFormat';

export type ChipVariant = 'draft' | 'committed' | 'denomination';

export interface ChipProps {
  readonly amount: Subunits;
  readonly variant: ChipVariant;
  /** Pixel diameter. */
  readonly size?: number;
  /** Committed bet revealed as a winner (only set after the result is revealed). */
  readonly won?: boolean;
  readonly className?: string;
  /** Hide from assistive tech when the parent already announces the amount. */
  readonly decorative?: boolean;
}

/** Denomination colours (theme tokens only). Unknown values fall back to champagne gold. */
const DENOMINATION_TONE: Record<number, string> = {
  10: 'bg-ivory text-ink border-ink-muted',
  50: 'bg-warning text-white border-white/80',
  100: 'bg-steel text-ink border-white/80',
  500: 'bg-pocket-red text-white border-white/80',
  2500: 'bg-primary text-white border-white/80',
  10000: 'bg-pocket-black text-champagne border-champagne',
};

const VARIANT_TONE: Record<Exclude<ChipVariant, 'denomination'>, string> = {
  // Draft chips: gold, like the Stitch reference.
  draft: 'bg-champagne text-walnut-dark border-walnut/70',
  // Committed chips: indigo with an ivory dashed rim so they read as "locked by the server".
  committed: 'bg-secondary text-white border-ivory/90',
};

export function Chip({ amount, variant, size = 22, won = false, className = '', decorative = true }: ChipProps) {
  const tone =
    variant === 'denomination' ? (DENOMINATION_TONE[amount] ?? VARIANT_TONE.draft) : VARIANT_TONE[variant];
  const text = chipLabel(amount);
  // Scale the face text with the chip and the label length.
  const fontPx = Math.max(7, Math.round(size * (text.length <= 3 ? 0.4 : text.length === 4 ? 0.34 : 0.3)));
  return (
    <span
      aria-hidden={decorative || undefined}
      title={formatCredits(amount)}
      data-chip={variant}
      className={[
        'pointer-events-none inline-flex shrink-0 select-none items-center justify-center rounded-full',
        'border-2 border-dashed font-mono font-bold leading-none tracking-tighter shadow-[0_3px_6px_rgba(0,0,0,0.45)]',
        tone,
        won ? 'ring-2 ring-champagne-pale ring-offset-1 ring-offset-felt-dark' : '',
        className,
      ].join(' ')}
      style={{ width: size, height: size, fontSize: fontPx }}
    >
      {text}
    </span>
  );
}

export default Chip;
