/**
 * Session export serialisers (JSON and CSV). Pure functions over a SessionExport, which only
 * ever contains what the repository stored — never secrets, env or server config.
 *
 * Masking (defence in depth): stored text is supposed to be redacted by whoever stored it, but a
 * provider could still echo a key back inside text that was stored verbatim (explanation, raw
 * output, model names…). So both serialisers finish with redact() (../redact.ts): every string
 * value is redacted first (JSON: before serialising, so escapes stay intact; CSV: every text
 * cell), then a final redact() pass runs over the whole output text. That final pass is kept only
 * if the file structure survives it (JSON still parses; CSV has the same quotes, commas and line
 * breaks), so masking can never produce a broken file.
 *
 * CSV rules:
 *  - RFC 4180: comma separated, CRLF line endings, cells quoted when they contain a quote,
 *    comma, CR or LF; quotes doubled inside quoted cells.
 *  - Spreadsheet formula injection: TEXT cells beginning with = + - @ TAB or CR get a leading
 *    apostrophe. Numeric cells (round number, winning number, money, tokens, cost) are left numeric.
 *  - Money is written as exact decimal credits computed with integer math (1234 → "12.34",
 *    -5 → "-0.05"); floating point is never used to format subunits.
 *  - decision_* token and cost columns are summed over EVERY attempt (usage record) of the round's
 *    decision, matched by decisionId. A cell is blank when no attempt reported that number
 *    (including rounds without a decision). decision_cost_usd is plain decimal US dollars
 *    (virtual credits are never involved); decision_cost_basis says how it was obtained.
 */
import {
  SUBUNITS_PER_CREDIT,
  type DecisionRecord,
  type RoundRecord,
  type Subunits,
  type UsageRecord,
} from '../../shared/contracts.js';
import { colorOf } from '../../shared/roulette.js';
import { redact } from '../redact.js';
import type { SessionExport } from '../types.js';

/** Deep copy of a JSON-like value with every string passed through redact(). Keys are kept. */
export function redactStrings<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactStrings(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactStrings(v);
    return out as T;
  }
  return value;
}

/**
 * Pretty-printed JSON, newline terminated, with secrets masked. When nothing in the export looks
 * like a secret, `JSON.parse(toJsonExport(x))` deep-equals `x`.
 */
export function toJsonExport(exp: SessionExport): string {
  const text = JSON.stringify(redactStrings(exp), null, 2);
  const final = redact(text);
  if (final !== text) {
    try {
      JSON.parse(final);
      return `${final}\n`;
    } catch {
      // The text-level pass cut through a JSON escape; the value-level pass above already masked
      // every string, so keep that valid output.
    }
  }
  return `${text}\n`;
}

export const CSV_COLUMNS = [
  'round',
  'status',
  'committed_at',
  'settled_at',
  'source',
  'decision_action',
  'decision_explanation',
  'bets',
  'total_stake',
  'winning_number',
  'color',
  'stake_returned',
  'winnings',
  'total_returned',
  'net',
  'balance_before',
  'balance_after',
  'decision_input_tokens',
  'decision_output_tokens',
  'decision_cached_tokens',
  'decision_cost_usd',
  'decision_cost_basis',
] as const;

/** Exact decimal credits from integer subunits using integer arithmetic only. */
export function formatSubunitsDecimal(amount: Subunits): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Not an integer subunit amount: ${amount}`);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const frac = abs % SUBUNITS_PER_CREDIT;
  const whole = (abs - frac) / SUBUNITS_PER_CREDIT; // exact: abs - frac is a multiple of 100
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * Micro-USD (may be fractional) as a plain decimal USD string for spreadsheets: up to 9 decimal
 * places (nano-dollars), trailing zeros removed. 1234.5 → "0.0012345", 0 → "0", 2_500_000 → "2.5".
 */
export function formatMicrosUsd(micros: number): string {
  if (!Number.isFinite(micros)) throw new RangeError(`Not a finite micro-USD amount: ${micros}`);
  const fixed = (micros / 1_000_000).toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

/** Prefix an apostrophe to text a spreadsheet would otherwise evaluate as a formula. */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** RFC 4180 quoting for one cell. */
export function csvQuote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

type Cell = { kind: 'text'; value: string | null } | { kind: 'number'; value: string | null };

const text = (value: string | null | undefined): Cell => ({ kind: 'text', value: value ?? null });
const int = (value: number | null | undefined): Cell => ({
  kind: 'number',
  value: value == null ? null : String(value),
});
const money = (value: Subunits | null | undefined): Cell => ({
  kind: 'number',
  value: value == null ? null : formatSubunitsDecimal(value),
});
const usd = (micros: number | null | undefined): Cell => ({
  kind: 'number',
  value: micros == null ? null : formatMicrosUsd(micros),
});

function renderCell(cell: Cell): string {
  if (cell.value === null) return '';
  const value = cell.kind === 'text' ? neutraliseFormula(redact(cell.value)) : cell.value;
  return csvQuote(value);
}

function betsCell(round: RoundRecord): string {
  return round.bets.map((b) => `${b.label} ${formatSubunitsDecimal(b.stake)}`).join('; ');
}

/** Per-decision usage totals over all attempts; null = no attempt reported that number. */
interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costMicros: number | null;
  costBasis: string | null;
}

const addKnown = (sum: number | null, value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? (sum ?? 0) + value : sum;

function usageByDecision(records: readonly UsageRecord[]): Map<string, DecisionUsage> {
  const out = new Map<string, DecisionUsage & { bases: Set<string> }>();
  for (const u of records) {
    let acc = out.get(u.decisionId);
    if (!acc) {
      acc = { inputTokens: null, outputTokens: null, cachedTokens: null, costMicros: null, costBasis: null, bases: new Set() };
      out.set(u.decisionId, acc);
    }
    acc.inputTokens = addKnown(acc.inputTokens, u.inputTokens);
    acc.outputTokens = addKnown(acc.outputTokens, u.outputTokens);
    // "Cached" = input tokens served from the provider's prompt cache (cache reads).
    acc.cachedTokens = addKnown(acc.cachedTokens, u.cacheReadTokens);
    acc.costMicros = addKnown(acc.costMicros, u.costMicros);
    if (typeof u.costMicros === 'number' && u.costBasis) acc.bases.add(u.costBasis);
  }
  for (const acc of out.values()) acc.costBasis = acc.bases.size ? [...acc.bases].join('; ') : null;
  return out;
}

/** One row per round (oldest first, as exported), with a header row. */
export function toCsvExport(exp: SessionExport): string {
  const decisions = new Map<string, DecisionRecord>(exp.decisions.map((d) => [d.id, d]));
  const usage = usageByDecision(exp.usage ?? []);
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const round of exp.rounds) {
    const decision = round.decisionId ? decisions.get(round.decisionId) : undefined;
    const u = round.decisionId ? usage.get(round.decisionId) : undefined;
    const cells: Cell[] = [
      int(round.seq),
      text(round.status),
      text(round.committedAt),
      text(round.settledAt),
      text(round.source),
      text(decision?.action ?? null),
      text(decision?.explanation ?? null),
      text(betsCell(round)),
      money(round.totalStake),
      int(round.winningNumber),
      text(round.winningNumber === null ? null : colorOf(round.winningNumber)),
      money(round.stakeReturned),
      money(round.winnings),
      money(round.totalReturned),
      money(round.net),
      money(round.balanceBefore),
      money(round.balanceAfter),
      int(u?.inputTokens),
      int(u?.outputTokens),
      int(u?.cachedTokens),
      usd(u?.costMicros),
      text(u?.costBasis ?? null),
    ];
    lines.push(cells.map(renderCell).join(','));
  }
  const csv = `${lines.join('\r\n')}\r\n`;
  // Final pass over the whole text. Some redact() rules may run past a comma or line break (e.g.
  // "?key=…" stops only at & / whitespace / quotes), which would shift cells; keep the pass only
  // when the sequence of CSV structure characters is unchanged. Every text cell was already
  // redacted on its own above.
  const final = redact(csv);
  return final === csv || csvStructure(final) === csvStructure(csv) ? final : csv;
}

/** The quote / comma / CR / LF characters of a CSV text, in order (its cell and row structure). */
function csvStructure(csv: string): string {
  return (csv.match(/[",\r\n]/g) ?? []).join('');
}
