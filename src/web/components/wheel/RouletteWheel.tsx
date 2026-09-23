// OWNER: wheel agent. STUB — replaced by the real SVG wheel (props contract in ../../contracts.ts).
import type { RouletteWheelProps } from '../../contracts';

export type { RouletteWheelProps };

export function RouletteWheel({ className }: RouletteWheelProps) {
  return <div className={className} aria-label="Roulette wheel (loading)" />;
}
export default RouletteWheel;
