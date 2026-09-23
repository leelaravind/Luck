/**
 * Display formatting for the dashboard. Display only — never used to compute money on the client.
 */
import { describeBet } from '../../shared/bets';
import type { BetInput, PlayerConfig, ProviderStatus, UsdMicros } from '../../shared/contracts';
import { MICROS_PER_USD } from '../../shared/contracts';
import { formatCredits, formatUsdMicros } from '../../shared/money';
import { colorOf } from '../../shared/roulette';

export { formatCredits, formatUsdMicros };

const intFmt = new Intl.NumberFormat('en-US');

export function formatInt(n: number): string {
  return intFmt.format(n);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatTokensPerSec(v: number): string {
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} tok/s`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Parse a USD amount ("0.25", "5") into integer micro-USD without floating point.
 * Returns null for signs, exponents, more than 6 decimals or junk.
 */
export function parseUsdToMicros(text: string): UsdMicros | null {
  const m = /^\s*\$?\s*(\d{1,9})(?:\.(\d{1,6}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * MICROS_PER_USD + (m[2] ? Number(m[2].padEnd(6, '0')) : 0);
}

/** Micro-USD → plain decimal string for an input field ("0.25"). */
export function microsToUsdInput(micros: UsdMicros): string {
  const whole = Math.floor(micros / MICROS_PER_USD);
  const frac = String(micros % MICROS_PER_USD).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Subunits → plain decimal string for an input field ("12.30"). */
export function subunitsToInput(amount: number): string {
  return formatCredits(amount).replace('V$ ', '').replace(/,/g, '');
}

/** "17 black", "0 green". */
export function pocketLabel(n: number): string {
  return `${n} ${colorOf(n)}`;
}

/**
 * Human label for a bet (possibly an invalid one proposed by a model). Uses the shared describeBet when it
 * accepts the bet, otherwise shows the raw fields so nothing is silently "repaired".
 */
export function betLabel(bet: Omit<BetInput, 'stake'>): string {
  try {
    const label = describeBet(bet);
    if (label) return label;
  } catch {
    // fall through to the raw description
  }
  const nums = Array.isArray(bet.numbers) && bet.numbers.length ? ` ${bet.numbers.join('/')}` : '';
  const idx = typeof bet.index === 'number' ? ` #${bet.index}` : '';
  return `${String(bet.type)}${nums}${idx}`;
}

/** "Anthropic · <model>" etc. The model name always comes from the session/player config. */
export function playerLabel(player: PlayerConfig, providers: readonly ProviderStatus[]): string {
  if (player.kind === 'manual') return 'Manual (you)';
  if (player.kind === 'demo') return 'Demo player (rule-based, not AI)';
  const label = providers.find((p) => p.kind === player.kind)?.capabilities.label ?? player.kind;
  return player.model ? `${label} · ${player.model}` : label;
}

/**
 * Split a stored decision explanation into the model's stated strategy and the rest. The server
 * stores "Strategy: <name>" on the first line when the model named one.
 */
export function splitStatedStrategy(text: string | null | undefined): { strategy: string | null; explanation: string | null } {
  if (!text) return { strategy: null, explanation: null };
  const m = /^Strategy: ([^\n]+)(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return { strategy: null, explanation: text };
  const rest = m[2]?.trim() ?? '';
  return { strategy: m[1]!.trim(), explanation: rest === '' ? null : rest };
}
