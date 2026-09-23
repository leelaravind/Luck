/**
 * Session export serialisers (JSON and CSV). Pure functions over a SessionExport, which only
 * ever contains what the repository stored — never secrets, env or server config.
 *
 * CSV rules:
 *  - RFC 4180: comma separated, CRLF line endings, cells quoted when they contain a quote,
 *    comma, CR or LF; quotes doubled inside quoted cells.
 *  - Spreadsheet formula injection: TEXT cells beginning with = + - @ TAB or CR get a leading
 *    apostrophe. Numeric cells (round number, winning number, money) are left numeric.
 *  - Money is written as exact decimal credits computed with integer math (1234 → "12.34",
 *    -5 → "-0.05"); floating point is never used to format subunits.
 */
import { SUBUNITS_PER_CREDIT, type DecisionRecord, type RoundRecord, type Subunits } from '../../shared/contracts.js';
import { colorOf } from '../../shared/roulette.js';
import type { SessionExport } from '../types.js';

/** Pretty-printed JSON, newline terminated. `JSON.parse(toJsonExport(x))` deep-equals `x`. */
export function toJsonExport(exp: SessionExport): string {
  return `${JSON.stringify(exp, null, 2)}\n`;
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

function renderCell(cell: Cell): string {
  if (cell.value === null) return '';
  const value = cell.kind === 'text' ? neutraliseFormula(cell.value) : cell.value;
  return csvQuote(value);
}

function betsCell(round: RoundRecord): string {
  return round.bets.map((b) => `${b.label} ${formatSubunitsDecimal(b.stake)}`).join('; ');
}

/** One row per round (oldest first, as exported), with a header row. */
export function toCsvExport(exp: SessionExport): string {
  const decisions = new Map<string, DecisionRecord>(exp.decisions.map((d) => [d.id, d]));
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const round of exp.rounds) {
    const decision = round.decisionId ? decisions.get(round.decisionId) : undefined;
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
    ];
    lines.push(cells.map(renderCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
