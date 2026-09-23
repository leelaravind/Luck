import { SUBUNITS_PER_CREDIT, type Subunits } from './contracts.js';

/** Format integer subunits as "V$ 1,234.50". Display only. */
export function formatCredits(amount: Subunits, opts: { sign?: boolean } = {}): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / SUBUNITS_PER_CREDIT);
  const frac = abs % SUBUNITS_PER_CREDIT;
  const body = `${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
  const sign = negative ? '−' : opts.sign && amount > 0 ? '+' : '';
  return `${sign}V$ ${body}`;
}

/**
 * Parse a decimal credit string ("12.30") into integer subunits without floating point.
 * Returns null for anything with more than 2 decimals, signs, exponents or junk.
 */
export function parseCredits(text: string): Subunits | null {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return whole * SUBUNITS_PER_CREDIT + frac;
}

export function isSubunits(n: unknown): n is Subunits {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

export function formatUsdMicros(micros: number | null | undefined): string {
  if (micros == null) return '—';
  const usd = micros / 1_000_000;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
