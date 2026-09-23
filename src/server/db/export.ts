/**
 * Session export serialisers (JSON and CSV). Pure functions over a SessionExport, which only
 * ever contains what the repository stored — never secrets, env or server config.
 *
 * Masking (defence in depth): stored text is supposed to be redacted by whoever stored it, but a
 * provider could still echo a key back inside text that was stored verbatim. So the serialisers
 * run redact() (../redact.ts) over the FREE-TEXT fields only. toJsonExport() goes through
 * redactExport(): decision explanation / rawOutput / errorMessage / validationErrors / providerNote /
 * model, usage model, log messages, the session name and message, the player's model, and the
 * credential-bearing parts of the player's base URL (user info, query, fragment). toCsvExport()
 * masks its one free-text column, decision_explanation. Structured fields are never touched: ids,
 * enums (kind, providerKind, status, source, action, costBasis …), timestamps, numbers, generated
 * bet labels and a URL's scheme, host and path. There is no pass over the serialised text, so the
 * JSON always parses and the CSV keeps its cells.
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
  type LogEntry,
  type PlayerConfig,
  type RoundRecord,
  type SessionInfo,
  type Subunits,
  type UsageRecord,
} from '../../shared/contracts.js';
import { colorOf } from '../../shared/roulette.js';
import { REDACTED, redact } from '../redact.js';
import type { SessionExport } from '../types.js';

/** redact() for an optional free-text value; null / undefined / non-strings pass through unchanged. */
function maskText<T>(value: T): T {
  return (typeof value === 'string' ? redact(value) : value) as T;
}

/**
 * Mask only the parts of a URL that can carry a credential — user info ("user:pass@"), the query
 * string and the fragment. The scheme, host, port and path are kept verbatim, so a registered value
 * that happens to equal a host or path segment never corrupts the address.
 */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  let head = cut === -1 ? url : url.slice(0, cut);
  const tail = cut === -1 ? '' : url.slice(cut);
  // "scheme://user:pass@host/…" → "scheme://[redacted]@host/…" (the "@" must come before the path).
  head = head.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, `$1${REDACTED}@`);
  return head + (tail ? redact(tail) : '');
}

function redactPlayer(player: PlayerConfig): PlayerConfig {
  if (player === null || typeof player !== 'object') return player;
  const out: PlayerConfig = { ...player };
  if (typeof out.model === 'string') out.model = redact(out.model);
  if (typeof out.baseUrl === 'string') out.baseUrl = redactUrl(out.baseUrl);
  return out;
}

function redactSession(session: SessionInfo): SessionInfo {
  return { ...session, name: maskText(session.name), message: maskText(session.message), player: redactPlayer(session.player) };
}

function redactDecision(d: DecisionRecord): DecisionRecord {
  const out: DecisionRecord = {
    ...d,
    model: maskText(d.model),
    explanation: maskText(d.explanation),
    rawOutput: maskText(d.rawOutput),
    errorMessage: maskText(d.errorMessage),
    validationErrors: Array.isArray(d.validationErrors) ? d.validationErrors.map((e) => maskText(e)) : d.validationErrors,
  };
  if ('providerNote' in d) out.providerNote = maskText(d.providerNote);
  return out;
}

/** Usage records hold numbers and enums; the model name is the only provider-echoed text. */
function redactUsage(u: UsageRecord): UsageRecord {
  return { ...u, model: maskText(u.model) };
}

function redactLog(l: LogEntry): LogEntry {
  return { ...l, message: maskText(l.message) };
}

/**
 * Copy of an export with secrets masked in its free-text fields only (see the file comment for the
 * list). Rounds, ledger entries, ids, enums, timestamps and numbers are returned unchanged, and the
 * input is never mutated. toJsonExport() calls this and toCsvExport() masks its one free-text cell
 * itself, so callers do not need a masking pass of their own (a whole-object pass would also mask
 * ids, enums and URLs).
 */
export function redactExport(exp: SessionExport): SessionExport {
  const mapArray = <T>(items: T[], fn: (item: T) => T): T[] => (Array.isArray(items) ? items.map(fn) : items);
  return {
    ...exp,
    session: exp.session ? redactSession(exp.session) : exp.session,
    decisions: mapArray(exp.decisions, redactDecision),
    usage: mapArray(exp.usage, redactUsage),
    logs: mapArray(exp.logs, redactLog),
  };
}

/**
 * Pretty-printed JSON, newline terminated, with secrets masked in the free-text fields. When nothing
 * in the export looks like a secret, `JSON.parse(toJsonExport(x))` deep-equals `x`.
 */
export function toJsonExport(exp: SessionExport): string {
  return `${JSON.stringify(redactExport(exp), null, 2)}\n`;
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

/**
 * A CSV cell. 'free' = free text (masked with redact(), then formula-neutralised); 'label' = an enum,
 * timestamp or app-generated label (formula-neutralised, never masked: it cannot hold a secret and
 * masking would corrupt it); 'number' = numeric (written as is).
 */
type Cell = { kind: 'free' | 'label' | 'number'; value: string | null };

const free = (value: string | null | undefined): Cell => ({ kind: 'free', value: value ?? null });
const label = (value: string | null | undefined): Cell => ({ kind: 'label', value: value ?? null });
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
  const value =
    cell.kind === 'free' ? neutraliseFormula(redact(cell.value)) : cell.kind === 'label' ? neutraliseFormula(cell.value) : cell.value;
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

/**
 * One row per round (oldest first, as exported), with a header row. The free-text cell is masked
 * with redact(); enum, timestamp and label cells are written unchanged.
 */
export function toCsvExport(exp: SessionExport): string {
  const decisions = new Map<string, DecisionRecord>(exp.decisions.map((d) => [d.id, d]));
  const usage = usageByDecision(exp.usage ?? []);
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const round of exp.rounds) {
    const decision = round.decisionId ? decisions.get(round.decisionId) : undefined;
    const u = round.decisionId ? usage.get(round.decisionId) : undefined;
    const cells: Cell[] = [
      int(round.seq),
      label(round.status),
      label(round.committedAt),
      label(round.settledAt),
      label(round.source),
      label(decision?.action ?? null),
      free(decision?.explanation ?? null),
      label(betsCell(round)),
      money(round.totalStake),
      int(round.winningNumber),
      label(round.winningNumber === null ? null : colorOf(round.winningNumber)),
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
      label(u?.costBasis ?? null),
    ];
    lines.push(cells.map(renderCell).join(','));
  }
  // No pass over the finished text: the only free-text cell (decision_explanation) was masked on
  // its own above, so cells and rows can never shift and enum / timestamp cells stay intact.
  return `${lines.join('\r\n')}\r\n`;
}
