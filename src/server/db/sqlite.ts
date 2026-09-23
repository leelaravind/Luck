/**
 * SQLite implementation of the Repository contract (src/server/types.ts) on node:sqlite.
 *
 * Guarantees (backend-authoritative money):
 *  - Every money value is an integer number of subunits; non-integers are rejected before
 *    they reach SQL, and STRICT tables reject them again at the storage layer.
 *  - Methods marked [TX] in the contract run inside ONE `BEGIN IMMEDIATE` transaction and
 *    either fully apply or roll back and throw a GameError. Non-GameError failures (SQLite
 *    constraint/trigger errors) are rolled back and re-thrown as GameError with `cause` set.
 *  - A recorded outcome is never replaced; a round is settled at most once (enforced both here
 *    and by triggers / unique indexes in schema.ts).
 *  - Nothing secret is stored by construction: PlayerConfig is reduced to its known non-secret
 *    fields before it is written (see sanitizePlayer).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import {
  GameError,
  type ApiErrorCode,
  type BetInput,
  type DecisionRecord,
  type LogEntry,
  type PlayerConfig,
  type Pricing,
  type ResolvedBet,
  type RoundBet,
  type RoundRecord,
  type RoundSource,
  type SessionInfo,
  type Settlement,
  type UsageRecord,
} from '../../shared/contracts.js';
import { isRouletteNumber } from '../../shared/roulette.js';
import type { LedgerEntry, NewSession, Repository, SessionExport, SessionPatch } from '../types.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export const APP_NAME = 'Luck — AI Roulette Lab';
export const EXPORT_NOTICE =
  'Virtual credits only. Roulette outcomes are random and cannot be predicted; results do not demonstrate model skill.';

export interface OpenRepositoryOptions {
  /**
   * Application version written into exports (SessionExport.app.version).
   * Defaults to npm_package_version when started through npm, otherwise "unknown".
   */
  appVersion?: string;
  /** Clock for timestamps the repository creates itself (logs, settings, updatedAt, exportedAt). */
  now?: () => Date;
}

/**
 * Open (or create) the database at `dbPath` and migrate it to SCHEMA_VERSION.
 * ':memory:' gives a private in-memory database (tests).
 */
export function openRepository(dbPath: string, opts: OpenRepositoryOptions = {}): Repository {
  return new SqliteRepository(dbPath, opts);
}

// ───────────────────────────── row shapes ─────────────────────────────

type Row = Record<string, unknown>;

interface SessionRow {
  id: string;
  name: string;
  mode: SessionInfo['mode'];
  player: string;
  status: SessionInfo['status'];
  phase: SessionInfo['phase'];
  pause_reason: SessionInfo['pauseReason'];
  end_reason: SessionInfo['endReason'];
  message: string | null;
  balance: number;
  starting_balance: number;
  rounds_played: number;
  limits: string;
  epoch: number;
  runtime_ms: number;
  created_at: string;
  updated_at: string;
}

interface RoundRow {
  id: string;
  session_id: string;
  seq: number;
  status: RoundRecord['status'];
  source: RoundSource;
  decision_id: string | null;
  idempotency_key: string | null;
  total_stake: number;
  balance_before: number;
  winning_number: number | null;
  stake_returned: number | null;
  winnings: number | null;
  total_returned: number | null;
  net: number | null;
  balance_after: number | null;
  committed_at: string;
  outcome_at: string | null;
  settled_at: string | null;
}

interface BetRow {
  round_id: string;
  idx: number;
  key: string;
  type: RoundBet['type'];
  numbers: string;
  bet_index: number | null;
  stake: number;
  payout: number;
  label: string;
  won: number | null;
  returned: number | null;
}

interface DecisionRow {
  id: string;
  session_id: string;
  round_number: number;
  epoch: number;
  provider_kind: DecisionRecord['providerKind'];
  model: string | null;
  status: DecisionRecord['status'];
  action: DecisionRecord['action'];
  bets: string | null;
  explanation: string | null;
  raw_output: string | null;
  validation_errors: string;
  error_code: DecisionRecord['errorCode'];
  error_message: string | null;
  attempts: number;
  started_at: string;
  completed_at: string | null;
  latency_ms: number | null;
}

interface UsageRow {
  id: string;
  session_id: string;
  decision_id: string;
  attempt: number;
  provider_kind: UsageRecord['providerKind'];
  model: string | null;
  status: UsageRecord['status'];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  known: number;
  latency_ms: number | null;
  generation_ms: number | null;
  output_tokens_per_sec: number | null;
  cost_micros: number | null;
  cost_basis: UsageRecord['costBasis'];
  rate_limit: string | null;
  created_at: string;
}

interface LedgerRow {
  id: number;
  session_id: string;
  round_id: string | null;
  kind: LedgerEntry['kind'];
  amount: number;
  balance_after: number;
  created_at: string;
}

interface LogRow {
  id: number;
  session_id: string;
  level: LogEntry['level'];
  type: string;
  message: string;
  created_at: string;
}

// ───────────────────────────── helpers ─────────────────────────────

/** SQLite extended result codes surfaced by node:sqlite as `errcode`. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function assertSubunits(value: unknown, what: string, opts: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new GameError('validation_error', `${what} must be an integer number of subunits`, { value });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new GameError('validation_error', `${what} must be >= ${opts.min}`, { value });
  }
  return value;
}

function assertString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GameError('validation_error', `${what} must be a non-empty string`);
  }
  return value;
}

function json(value: unknown): string {
  // JSON.stringify(undefined) is undefined; store an explicit JSON null instead.
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

function parseJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/** Positive integer limit, or -1 (SQLite: no limit) for anything else. */
function sqlLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : -1;
}

/**
 * Reduce a PlayerConfig to its documented non-secret fields. Callers sometimes hold a
 * ResolvedProviderConfig (which extends PlayerConfig with apiKey/cliPath); copying only known
 * fields guarantees such values are never persisted or exported.
 * NOTE: if PlayerConfig gains fields in contracts.ts, add them here.
 */
export function sanitizePlayer(player: PlayerConfig): PlayerConfig {
  if (!player || typeof player !== 'object' || typeof player.kind !== 'string') {
    throw new GameError('validation_error', 'player.kind is required');
  }
  const out: PlayerConfig = { kind: player.kind };
  if (typeof player.model === 'string') out.model = player.model;
  if (typeof player.baseUrl === 'string') out.baseUrl = player.baseUrl;
  if (typeof player.temperature === 'number') out.temperature = player.temperature;
  if (typeof player.layaCheckpoint === 'string') out.layaCheckpoint = player.layaCheckpoint;
  if (player.pricing && typeof player.pricing === 'object') {
    const p = player.pricing;
    const pricing: Pricing = {
      inputPerMTokUsd: p.inputPerMTokUsd,
      outputPerMTokUsd: p.outputPerMTokUsd,
      source: p.source,
    };
    if (p.cacheReadPerMTokUsd !== undefined) pricing.cacheReadPerMTokUsd = p.cacheReadPerMTokUsd;
    if (p.cacheWritePerMTokUsd !== undefined) pricing.cacheWritePerMTokUsd = p.cacheWritePerMTokUsd;
    if (p.asOf !== undefined) pricing.asOf = p.asOf;
    out.pricing = pricing;
  }
  return out;
}

function toSession(r: SessionRow): SessionInfo {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    player: JSON.parse(r.player) as PlayerConfig,
    status: r.status,
    phase: r.phase,
    pauseReason: r.pause_reason,
    endReason: r.end_reason,
    message: r.message,
    balance: r.balance,
    startingBalance: r.starting_balance,
    roundsPlayed: r.rounds_played,
    limits: JSON.parse(r.limits) as SessionInfo['limits'],
    epoch: r.epoch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runtimeMs: r.runtime_ms,
  };
}

function toBet(r: BetRow): RoundBet {
  const bet: RoundBet = {
    key: r.key,
    type: r.type,
    numbers: JSON.parse(r.numbers) as number[],
    stake: r.stake,
    payout: r.payout,
    label: r.label,
    won: r.won === null ? null : r.won === 1,
    returned: r.returned,
  };
  if (r.bet_index !== null) bet.index = r.bet_index;
  return bet;
}

function toRound(r: RoundRow, bets: RoundBet[]): RoundRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    status: r.status,
    source: r.source,
    decisionId: r.decision_id,
    bets,
    totalStake: r.total_stake,
    balanceBefore: r.balance_before,
    winningNumber: r.winning_number,
    stakeReturned: r.stake_returned,
    winnings: r.winnings,
    totalReturned: r.total_returned,
    net: r.net,
    balanceAfter: r.balance_after,
    committedAt: r.committed_at,
    outcomeAt: r.outcome_at,
    settledAt: r.settled_at,
  };
}

function toDecision(r: DecisionRow): DecisionRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    roundNumber: r.round_number,
    epoch: r.epoch,
    providerKind: r.provider_kind,
    model: r.model,
    status: r.status,
    action: r.action,
    bets: parseJson<BetInput[]>(r.bets),
    explanation: r.explanation,
    rawOutput: r.raw_output,
    validationErrors: JSON.parse(r.validation_errors) as string[],
    errorCode: r.error_code,
    errorMessage: r.error_message,
    attempts: r.attempts,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    latencyMs: r.latency_ms,
  };
}

function toUsage(r: UsageRow): UsageRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    decisionId: r.decision_id,
    attempt: r.attempt,
    providerKind: r.provider_kind,
    model: r.model,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    known: r.known === 1,
    latencyMs: r.latency_ms,
    generationMs: r.generation_ms,
    outputTokensPerSec: r.output_tokens_per_sec,
    costMicros: r.cost_micros,
    costBasis: r.cost_basis,
    rateLimit: parseJson<UsageRecord['rateLimit']>(r.rate_limit),
    createdAt: r.created_at,
  };
}

function toLedger(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    roundId: r.round_id,
    kind: r.kind,
    amount: r.amount,
    balanceAfter: r.balance_after,
    createdAt: r.created_at,
  };
}

function toLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    level: r.level,
    type: r.type,
    message: r.message,
    createdAt: r.created_at,
  };
}

function decisionParams(d: DecisionRecord): SQLInputValue[] {
  return [
    d.id,
    d.sessionId,
    d.roundNumber,
    d.epoch,
    d.providerKind,
    d.model ?? null,
    d.status,
    d.action ?? null,
    d.bets == null ? null : json(d.bets),
    d.explanation ?? null,
    d.rawOutput ?? null,
    json(d.validationErrors ?? []),
    d.errorCode ?? null,
    d.errorMessage ?? null,
    d.attempts,
    d.startedAt,
    d.completedAt ?? null,
    d.latencyMs ?? null,
  ];
}

// ───────────────────────────── repository ─────────────────────────────

class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly now: () => Date;
  private readonly appVersion: string;
  private inTransaction = false;

  constructor(dbPath: string, opts: OpenRepositoryOptions) {
    this.now = opts.now ?? (() => new Date());
    this.appVersion = opts.appVersion ?? process.env.npm_package_version ?? 'unknown';

    const inMemory = dbPath === ':memory:';
    if (!inMemory) mkdirSync(dirname(resolve(dbPath)), { recursive: true });

    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA foreign_keys = ON');
      if (!inMemory) {
        const mode = this.db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
        if (mode?.journal_mode?.toLowerCase() !== 'wal') {
          throw new Error(`Could not enable WAL journal mode (got ${String(mode?.journal_mode)})`);
        }
        // FULL: a committed settlement survives power loss, not only a process crash.
        this.db.exec('PRAGMA synchronous = FULL');
      }
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  // ── infrastructure ──

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as unknown as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as unknown as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.stmt(sql).run(...params);
  }

  /**
   * Run `fn` inside BEGIN IMMEDIATE … COMMIT. Any throw rolls back. Nested calls are a
   * programming error and are refused. Non-GameError failures are wrapped (cause preserved).
   */
  private tx<T>(op: string, fn: () => T): T {
    if (this.inTransaction) throw new Error(`Nested transaction attempted in ${op}`);
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        if (this.db.isTransaction) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // The original error is more useful than a failed rollback.
          }
        }
        throw err;
      }
    } catch (err) {
      throw asGameError(op, err);
    } finally {
      this.inTransaction = false;
    }
  }

  /** Consistent read snapshot (deferred transaction) for multi-query reads such as exports. */
  private readSnapshot<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN');
      try {
        return fn();
      } finally {
        if (this.db.isTransaction) this.db.exec('COMMIT');
      }
    } finally {
      this.inTransaction = false;
    }
  }

  /** Apply forward migrations one version at a time, each in its own write transaction. */
  private migrate(): void {
    const version = (): number => {
      const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (v > SCHEMA_VERSION) {
        throw new Error(
          `Database schema version ${v} is newer than this build supports (${SCHEMA_VERSION}). ` +
            'Refusing to open it; use a newer version of Luck.',
        );
      }
      return v;
    };
    while (version() < SCHEMA_VERSION) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Re-read under the write lock: another process may have migrated in the meantime.
        const v = version();
        if (v < SCHEMA_VERSION) {
          this.db.exec(MIGRATIONS[v]!);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private sessionRow(id: string): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  private requireSessionRow(id: string): SessionRow {
    const row = this.sessionRow(id);
    if (!row) throw new GameError('not_found', `Session ${id} not found`);
    return row;
  }

  private betsFor(roundId: string): RoundBet[] {
    return this.all<BetRow>('SELECT * FROM round_bets WHERE round_id = ? ORDER BY idx', roundId).map(toBet);
  }

  private hydrate(row: RoundRow): RoundRecord {
    return toRound(row, this.betsFor(row.id));
  }

  private roundRow(id: string): RoundRow | undefined {
    return this.get<RoundRow>('SELECT * FROM rounds WHERE id = ?', id);
  }

  // ── sessions ──

  createSession(input: NewSession): SessionInfo {
    const id = assertString(input.id, 'session id');
    const start = assertSubunits(input.limits?.startingBalance, 'limits.startingBalance', { min: 0 });
    const player = sanitizePlayer(input.player);
    return this.tx('createSession', () => {
      if (this.sessionRow(id)) throw new GameError('duplicate_request', `Session ${id} already exists`);
      this.run(
        `INSERT INTO sessions (id, name, mode, player, status, phase, pause_reason, end_reason, message,
           balance, starting_balance, rounds_played, limits, epoch, runtime_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ready', 'ready', NULL, NULL, NULL, ?, ?, 0, ?, 0, 0, ?, ?)`,
        id,
        input.name,
        input.mode,
        json(player),
        start,
        start,
        json(input.limits),
        input.createdAt,
        input.createdAt,
      );
      this.run(
        `INSERT INTO ledger (session_id, round_id, kind, amount, balance_after, created_at)
         VALUES (?, NULL, 'session_start', ?, ?, ?)`,
        id,
        start,
        start,
        input.createdAt,
      );
      return toSession(this.requireSessionRow(id));
    });
  }

  getSession(id: string): SessionInfo | null {
    const row = this.sessionRow(id);
    return row ? toSession(row) : null;
  }

  /** Newest first. */
  listSessions(): SessionInfo[] {
    return this.all<SessionRow>('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC').map(toSession);
  }

  updateSession(id: string, patch: SessionPatch): SessionInfo {
    // Only the documented SessionPatch fields are writable; balance/roundsPlayed move only
    // through commitRound/settleRound.
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.phase !== undefined) set('phase', patch.phase);
    if (patch.pauseReason !== undefined) set('pause_reason', patch.pauseReason);
    if (patch.endReason !== undefined) set('end_reason', patch.endReason);
    if (patch.message !== undefined) set('message', patch.message);
    if (patch.epoch !== undefined) {
      if (!Number.isSafeInteger(patch.epoch)) throw new GameError('validation_error', 'epoch must be an integer');
      set('epoch', patch.epoch);
    }
    if (patch.runtimeMs !== undefined) set('runtime_ms', patch.runtimeMs);
    if (patch.player !== undefined) set('player', json(sanitizePlayer(patch.player)));
    if (patch.limits !== undefined) set('limits', json(patch.limits));

    return this.tx('updateSession', () => {
      this.requireSessionRow(id);
      set('updated_at', this.iso());
      this.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      return toSession(this.requireSessionRow(id));
    });
  }

  // ── rounds ──

  commitRound(input: {
    id: string;
    sessionId: string;
    source: RoundSource;
    decisionId: string | null;
    bets: ResolvedBet[];
    idempotencyKey: string | null;
    committedAt: string;
  }): RoundRecord {
    const roundId = assertString(input.id, 'round id');
    if (!Array.isArray(input.bets)) throw new GameError('validation_error', 'bets must be an array');
    const keys = new Set<string>();
    let totalStake = 0;
    for (const [i, bet] of input.bets.entries()) {
      assertSubunits(bet.stake, `bets[${i}].stake`, { min: 1 });
      if (!Number.isSafeInteger(bet.payout) || bet.payout < 1) {
        throw new GameError('invalid_bet', `bets[${i}].payout must be a positive integer`);
      }
      if (!Array.isArray(bet.numbers) || !bet.numbers.every(isRouletteNumber)) {
        throw new GameError('invalid_bet', `bets[${i}].numbers must be roulette numbers`);
      }
      if (keys.has(bet.key)) {
        // validateBetSlip merges identical positions; duplicates here are a caller bug.
        throw new GameError('invalid_bet', `Duplicate bet position ${bet.key} in one round`);
      }
      keys.add(bet.key);
      totalStake += bet.stake;
    }
    assertSubunits(totalStake, 'total stake', { min: 0 });

    return this.tx('commitRound', () => {
      const session = this.requireSessionRow(input.sessionId);

      // Idempotent replay: same key in this session → the original round, no new charge.
      if (input.idempotencyKey !== null && input.idempotencyKey !== undefined) {
        const existing = this.get<RoundRow>(
          'SELECT * FROM rounds WHERE session_id = ? AND idempotency_key = ?',
          input.sessionId,
          input.idempotencyKey,
        );
        if (existing) return this.hydrate(existing);
      }

      if (this.roundRow(roundId)) throw new GameError('duplicate_request', `Round ${roundId} already exists`);

      const open = this.get<{ id: string; status: string }>(
        "SELECT id, status FROM rounds WHERE session_id = ? AND status <> 'settled' LIMIT 1",
        input.sessionId,
      );
      if (open) {
        throw new GameError('round_in_progress', 'The previous round has not been settled yet', {
          roundId: open.id,
          status: open.status,
        });
      }

      if (session.balance < totalStake) {
        throw new GameError('insufficient_funds', 'Balance is lower than the total stake', {
          balance: session.balance,
          totalStake,
        });
      }

      if (input.decisionId !== null && input.decisionId !== undefined) {
        const d = this.get<{ session_id: string }>('SELECT session_id FROM decisions WHERE id = ?', input.decisionId);
        if (!d || d.session_id !== input.sessionId) {
          throw new GameError('validation_error', `Decision ${input.decisionId} not found in this session`);
        }
      }

      const { next } = this.get<{ next: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM rounds WHERE session_id = ?',
        input.sessionId,
      )!;
      const balanceAfterStake = session.balance - totalStake;

      this.run(
        `INSERT INTO rounds (id, session_id, seq, status, source, decision_id, idempotency_key,
           total_stake, balance_before, committed_at)
         VALUES (?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?)`,
        roundId,
        input.sessionId,
        next,
        input.source,
        input.decisionId ?? null,
        input.idempotencyKey ?? null,
        totalStake,
        session.balance,
        input.committedAt,
      );
      input.bets.forEach((bet, idx) => {
        this.run(
          `INSERT INTO round_bets (round_id, idx, key, type, numbers, bet_index, stake, payout, label, won, returned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          roundId,
          idx,
          bet.key,
          bet.type,
          json([...bet.numbers].sort((a, b) => a - b)),
          bet.index ?? null,
          bet.stake,
          bet.payout,
          bet.label,
        );
      });
      this.run(
        'UPDATE sessions SET balance = ?, updated_at = ? WHERE id = ?',
        balanceAfterStake,
        input.committedAt,
        input.sessionId,
      );
      if (totalStake > 0) {
        this.run(
          `INSERT INTO ledger (session_id, round_id, kind, amount, balance_after, created_at)
           VALUES (?, ?, 'stake', ?, ?, ?)`,
          input.sessionId,
          roundId,
          -totalStake,
          balanceAfterStake,
          input.committedAt,
        );
      }
      return this.hydrate(this.roundRow(roundId)!);
    });
  }

  recordOutcome(roundId: string, winningNumber: number, at: string): RoundRecord {
    if (!isRouletteNumber(winningNumber)) {
      throw new GameError('validation_error', 'Winning number must be an integer from 0 to 36', { winningNumber });
    }
    return this.tx('recordOutcome', () => {
      const row = this.roundRow(roundId);
      if (!row) throw new GameError('not_found', `Round ${roundId} not found`);
      // An existing outcome is NEVER replaced (restart recovery relies on this).
      if (row.winning_number !== null) return this.hydrate(row);
      this.run(
        `UPDATE rounds SET status = 'outcome_recorded', winning_number = ?, outcome_at = ?
         WHERE id = ? AND status = 'committed' AND winning_number IS NULL`,
        winningNumber,
        at,
        roundId,
      );
      return this.hydrate(this.roundRow(roundId)!);
    });
  }

  settleRound(roundId: string, settlement: Settlement, at: string): { round: RoundRecord; applied: boolean } {
    return this.tx('settleRound', () => {
      const row = this.roundRow(roundId);
      if (!row) throw new GameError('not_found', `Round ${roundId} not found`);
      if (row.status === 'settled') return { round: this.hydrate(row), applied: false };
      if (row.status !== 'outcome_recorded' || row.winning_number === null) {
        throw new GameError('invalid_state', 'Round has no recorded outcome yet', { roundId, status: row.status });
      }
      if (settlement.winningNumber !== row.winning_number) {
        throw new GameError('invalid_state', 'Settlement winning number does not match the recorded outcome', {
          recorded: row.winning_number,
          settlement: settlement.winningNumber,
        });
      }

      const bets = this.betsFor(roundId);
      verifySettlement(row, bets, settlement);

      const session = this.requireSessionRow(row.session_id);
      const newBalance = session.balance + settlement.totalReturned;
      assertSubunits(newBalance, 'balance after settlement', { min: 0 });

      bets.forEach((bet, idx) => {
        const result = settlement.bets.find((b) => b.key === bet.key)!;
        this.run(
          'UPDATE round_bets SET won = ?, returned = ? WHERE round_id = ? AND idx = ?',
          result.won ? 1 : 0,
          result.returned,
          roundId,
          idx,
        );
      });
      const changed = this.run(
        `UPDATE rounds SET status = 'settled', stake_returned = ?, winnings = ?, total_returned = ?, net = ?,
           balance_after = ?, settled_at = ?
         WHERE id = ? AND status = 'outcome_recorded'`,
        settlement.stakeReturned,
        settlement.winnings,
        settlement.totalReturned,
        settlement.net,
        newBalance,
        at,
        roundId,
      );
      if (Number(changed.changes) !== 1) throw new GameError('internal', 'Round changed during settlement');
      this.run(
        'UPDATE sessions SET balance = ?, rounds_played = rounds_played + 1, updated_at = ? WHERE id = ?',
        newBalance,
        at,
        row.session_id,
      );
      // Written even for a 0 return so every settlement is visible in the ledger.
      this.run(
        `INSERT INTO ledger (session_id, round_id, kind, amount, balance_after, created_at)
         VALUES (?, ?, 'payout', ?, ?, ?)`,
        row.session_id,
        roundId,
        settlement.totalReturned,
        newBalance,
        at,
      );
      return { round: this.hydrate(this.roundRow(roundId)!), applied: true };
    });
  }

  getRound(id: string): RoundRecord | null {
    const row = this.roundRow(id);
    return row ? this.hydrate(row) : null;
  }

  getLatestRound(sessionId: string): RoundRecord | null {
    const row = this.get<RoundRow>('SELECT * FROM rounds WHERE session_id = ? ORDER BY seq DESC LIMIT 1', sessionId);
    return row ? this.hydrate(row) : null;
  }

  /** Newest first (by seq). `beforeSeq` is exclusive. */
  listRounds(sessionId: string, opts: { limit?: number; beforeSeq?: number } = {}): RoundRecord[] {
    const before =
      typeof opts.beforeSeq === 'number' && Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : Number.MAX_SAFE_INTEGER;
    return this.all<RoundRow>(
      'SELECT * FROM rounds WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      sessionId,
      before,
      sqlLimit(opts.limit),
    ).map((r) => this.hydrate(r));
  }

  findRoundByIdempotencyKey(sessionId: string, key: string): RoundRecord | null {
    const row = this.get<RoundRow>('SELECT * FROM rounds WHERE session_id = ? AND idempotency_key = ?', sessionId, key);
    return row ? this.hydrate(row) : null;
  }

  /** Rounds in 'committed' or 'outcome_recorded' across all sessions, oldest commit first. */
  findUnsettledRounds(): RoundRecord[] {
    return this.all<RoundRow>(
      "SELECT * FROM rounds WHERE status <> 'settled' ORDER BY committed_at, session_id, seq",
    ).map((r) => this.hydrate(r));
  }

  // ── decisions ──

  insertDecision(rec: DecisionRecord): void {
    try {
      this.run(
        `INSERT INTO decisions (id, session_id, round_number, epoch, provider_kind, model, status, action, bets,
           explanation, raw_output, validation_errors, error_code, error_message, attempts, started_at,
           completed_at, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...decisionParams(rec),
      );
    } catch (err) {
      throw asGameError('insertDecision', err);
    }
  }

  updateDecision(id: string, patch: Partial<DecisionRecord>): DecisionRecord {
    return this.tx('updateDecision', () => {
      const row = this.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id);
      if (!row) throw new GameError('not_found', `Decision ${id} not found`);
      const merged: DecisionRecord = { ...toDecision(row) };
      for (const [k, v] of Object.entries(patch) as [keyof DecisionRecord, unknown][]) {
        if (v !== undefined && k !== 'id' && k !== 'sessionId') (merged as unknown as Row)[k] = v;
      }
      const p = decisionParams(merged);
      this.run(
        `UPDATE decisions SET round_number = ?, epoch = ?, provider_kind = ?, model = ?, status = ?, action = ?,
           bets = ?, explanation = ?, raw_output = ?, validation_errors = ?, error_code = ?, error_message = ?,
           attempts = ?, started_at = ?, completed_at = ?, latency_ms = ?
         WHERE id = ?`,
        ...p.slice(2),
        id,
      );
      return toDecision(this.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id)!);
    });
  }

  getDecision(id: string): DecisionRecord | null {
    const row = this.get<DecisionRow>('SELECT * FROM decisions WHERE id = ?', id);
    return row ? toDecision(row) : null;
  }

  /** Newest first. */
  listDecisions(sessionId: string, limit?: number): DecisionRecord[] {
    return this.all<DecisionRow>(
      'SELECT * FROM decisions WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
      sessionId,
      sqlLimit(limit),
    ).map(toDecision);
  }

  /** All decisions still 'pending' across sessions, oldest first (startup recovery). */
  findPendingDecisions(): DecisionRecord[] {
    return this.all<DecisionRow>(
      "SELECT * FROM decisions WHERE status = 'pending' ORDER BY started_at, rowid",
    ).map(toDecision);
  }

  // ── usage ──

  insertUsage(rec: UsageRecord): void {
    try {
      this.run(
        `INSERT INTO usage_records (id, session_id, decision_id, attempt, provider_kind, model, status,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, known,
           latency_ms, generation_ms, output_tokens_per_sec, cost_micros, cost_basis, rate_limit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rec.id,
        rec.sessionId,
        rec.decisionId,
        rec.attempt,
        rec.providerKind,
        rec.model ?? null,
        rec.status,
        rec.inputTokens ?? null,
        rec.outputTokens ?? null,
        rec.cacheReadTokens ?? null,
        rec.cacheWriteTokens ?? null,
        rec.reasoningTokens ?? null,
        rec.known ? 1 : 0,
        rec.latencyMs ?? null,
        rec.generationMs ?? null,
        rec.outputTokensPerSec ?? null,
        rec.costMicros ?? null,
        rec.costBasis,
        rec.rateLimit == null ? null : json(rec.rateLimit),
        rec.createdAt,
      );
    } catch (err) {
      throw asGameError('insertUsage', err);
    }
  }

  /** Oldest first. */
  listUsage(sessionId: string): UsageRecord[] {
    return this.all<UsageRow>(
      'SELECT * FROM usage_records WHERE session_id = ? ORDER BY created_at, rowid',
      sessionId,
    ).map(toUsage);
  }

  // ── logs ──

  appendLog(sessionId: string, level: LogEntry['level'], type: string, message: string): LogEntry {
    const createdAt = this.iso();
    try {
      const res = this.run(
        'INSERT INTO logs (session_id, level, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        level,
        type,
        message,
        createdAt,
      );
      return { id: Number(res.lastInsertRowid), sessionId, level, type, message, createdAt };
    } catch (err) {
      throw asGameError('appendLog', err);
    }
  }

  /** Newest first. */
  listLogs(sessionId: string, limit?: number): LogEntry[] {
    return this.all<LogRow>('SELECT * FROM logs WHERE session_id = ? ORDER BY id DESC LIMIT ?', sessionId, sqlLimit(limit)).map(
      toLog,
    );
  }

  // ── ledger ──

  /** Oldest first. */
  listLedger(sessionId: string): LedgerEntry[] {
    return this.all<LedgerRow>('SELECT * FROM ledger WHERE session_id = ? ORDER BY id', sessionId).map(toLedger);
  }

  // ── idempotency ──

  getIdempotent(scope: string, key: string): unknown | null {
    const row = this.get<{ response: string }>('SELECT response FROM idempotency WHERE scope = ? AND key = ?', scope, key);
    return row ? (JSON.parse(row.response) as unknown) : null;
  }

  /** First write wins: a replayed key keeps the ORIGINAL stored response. */
  putIdempotent(scope: string, key: string, response: unknown): void {
    this.run(
      'INSERT INTO idempotency (scope, key, response, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, key) DO NOTHING',
      scope,
      key,
      json(response),
      this.iso(),
    );
  }

  // ── settings ──

  getSetting<T>(key: string): T | null {
    const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  putSetting(key: string, value: unknown): void {
    this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      json(value),
      this.iso(),
    );
  }

  // ── export ──

  /**
   * Everything recorded for one session, chronological (oldest first) in every list.
   * Contains only what the repository stores, which never includes secrets or server config.
   */
  exportSession(sessionId: string): SessionExport {
    return this.readSnapshot(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new GameError('not_found', `Session ${sessionId} not found`);
      return {
        exportedAt: this.iso(),
        app: { name: APP_NAME, version: this.appVersion },
        notice: EXPORT_NOTICE,
        session,
        rounds: this.all<RoundRow>('SELECT * FROM rounds WHERE session_id = ? ORDER BY seq', sessionId).map((r) =>
          this.hydrate(r),
        ),
        decisions: this.all<DecisionRow>(
          'SELECT * FROM decisions WHERE session_id = ? ORDER BY started_at, rowid',
          sessionId,
        ).map(toDecision),
        usage: this.listUsage(sessionId),
        ledger: this.listLedger(sessionId),
        logs: this.all<LogRow>('SELECT * FROM logs WHERE session_id = ? ORDER BY id', sessionId).map(toLog),
      };
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
    this.statements.clear();
  }
}

// ───────────────────────────── settlement verification ─────────────────────────────

/**
 * Check that a Settlement is internally consistent and matches the stored bets exactly, so a
 * buggy caller can never credit an amount the stored round does not justify. Pure integer math.
 */
function verifySettlement(row: RoundRow, bets: RoundBet[], s: Settlement): void {
  const fail = (message: string, details?: unknown): never => {
    throw new GameError('internal', `Settlement rejected: ${message}`, details);
  };
  for (const [name, value] of [
    ['totalStake', s.totalStake],
    ['stakeReturned', s.stakeReturned],
    ['winnings', s.winnings],
    ['totalReturned', s.totalReturned],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`, { [name]: value });
  }
  if (!Number.isSafeInteger(s.net)) fail('net must be an integer');
  if (s.totalStake !== row.total_stake) fail('total stake differs from the committed round');
  if (s.totalReturned !== s.stakeReturned + s.winnings) fail('totalReturned != stakeReturned + winnings');
  if (s.net !== s.totalReturned - s.totalStake) fail('net != totalReturned - totalStake');
  if (!Array.isArray(s.bets) || s.bets.length !== bets.length) {
    fail('settlement bets do not match the committed bets', { committed: bets.map((b) => b.key) });
  }

  const byKey = new Map(s.bets.map((b) => [b.key, b]));
  if (byKey.size !== s.bets.length) fail('duplicate bet key in settlement');

  let stakeReturned = 0;
  let winnings = 0;
  const winning = row.winning_number!;
  for (const bet of bets) {
    const r = byKey.get(bet.key);
    if (!r) fail(`missing result for bet ${bet.key}`);
    const expectedWon = bet.numbers.includes(winning);
    const expectedReturned = expectedWon ? bet.stake * (bet.payout + 1) : 0;
    if (r!.won !== expectedWon || r!.returned !== expectedReturned) {
      fail(`result for ${bet.key} does not match the stored bet`, {
        key: bet.key,
        expected: { won: expectedWon, returned: expectedReturned },
        got: { won: r!.won, returned: r!.returned },
      });
    }
    if (expectedWon) {
      stakeReturned += bet.stake;
      winnings += bet.stake * bet.payout;
    }
  }
  if (stakeReturned !== s.stakeReturned || winnings !== s.winnings) {
    fail('totals do not match the per-bet results', {
      expected: { stakeReturned, winnings },
      got: { stakeReturned: s.stakeReturned, winnings: s.winnings },
    });
  }
}

// ───────────────────────────── error mapping ─────────────────────────────

function asGameError(op: string, err: unknown): GameError {
  if (err instanceof GameError) return err;
  const errcode = (err as { errcode?: unknown })?.errcode;
  let code: ApiErrorCode = 'internal';
  let message = `Database error in ${op}`;
  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    code = 'not_found';
    message = `${op}: a referenced session, round or decision does not exist`;
  } else if (errcode === SQLITE_CONSTRAINT_PRIMARYKEY || errcode === SQLITE_CONSTRAINT_UNIQUE) {
    code = 'duplicate_request';
    message = `${op}: record already exists`;
  }
  const wrapped = new GameError(code, message);
  wrapped.cause = err;
  return wrapped;
}
