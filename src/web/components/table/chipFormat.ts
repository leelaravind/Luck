/**
 * OWNER: betting-table agent (A5). Compact chip face text. Display only — the full amount is always
 * available as formatCredits() in the chip's title / aria-label and in the bet slip.
 */
import { SUBUNITS_PER_CREDIT, type Subunits } from '../../../shared/contracts';

/**
 * Short text that fits on a ~22px chip, using integer math only:
 *   10 → ".10", 50 → ".50", 100 → "1", 150 → "1.50", 2500 → "25", 10000 → "100",
 *   125000 → "1.2K", 12500000 → "125K", 250000000 → "2.5M".
 */
export function chipLabel(amount: Subunits): string {
  const abs = Math.abs(Math.trunc(amount));
  const sign = amount < 0 ? '−' : '';
  const whole = Math.floor(abs / SUBUNITS_PER_CREDIT);
  const frac = abs % SUBUNITS_PER_CREDIT;
  if (whole === 0) return `${sign}.${String(frac).padStart(2, '0')}`;
  if (whole < 1000) return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(frac).padStart(2, '0')}`;
  const [div, suffix] = whole < 1_000_000 ? [1000, 'K'] : [1_000_000, 'M'];
  const tenths = Math.floor((whole * 10) / div); // truncated to one decimal, never rounded up
  const intPart = Math.floor(tenths / 10);
  const dec = tenths % 10;
  return `${sign}${intPart >= 100 || dec === 0 ? intPart : `${intPart}.${dec}`}${suffix}`;
}
