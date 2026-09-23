import { colorOf } from '../../../shared/roulette';

/** Circular roulette result chip; colour comes from the pocket, the number is always printed. */
export interface NumberChipProps {
  readonly number: number;
  /** Round number shown under the chip so history is never mistaken for the current spin. */
  readonly round?: number;
  readonly size?: 'sm' | 'md' | 'lg';
  /** Ring for the most recent revealed result. */
  readonly latest?: boolean;
}

const BG = { red: 'bg-pocket-red', black: 'bg-pocket-black', green: 'bg-pocket-green' } as const;
const SIZE = { sm: 'h-7 w-7 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-14 w-14 text-2xl' } as const;

export function NumberChip({ number, round, size = 'md', latest = false }: Readonly<NumberChipProps>) {
  const color = colorOf(number);
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span
        className={`tnum inline-flex items-center justify-center rounded-full font-mono font-bold text-card shadow-raised ${BG[color]} ${SIZE[size]} ${latest ? 'ring-2 ring-champagne' : ''}`}
        aria-label={`${number} ${color}`}
      >
        {number}
      </span>
      {round !== undefined ? (
        <span className="tnum font-mono text-[10px] leading-none text-champagne-light/80">#{round}</span>
      ) : null}
    </span>
  );
}

export default NumberChip;
