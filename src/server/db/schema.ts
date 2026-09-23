/**
 * SQLite schema for Luck (node:sqlite, STRICT tables).
 *
 * Versioning: the schema version lives in `PRAGMA user_version`. MIGRATIONS[i] upgrades a
 * database from version i to version i + 1 and runs inside its own BEGIN IMMEDIATE
 * transaction together with the `user_version` bump (see sqlite.ts → migrate()).
 *
 * RULES FOR CHANGING THE SCHEMA
 *  - Never edit a migration that has shipped. Append a new one and bump SCHEMA_VERSION.
 *  - Every money column is INTEGER subunits. STRICT tables make SQLite reject a REAL
 *    (fractional) value in an INTEGER column instead of silently storing it.
 *  - Durations and cost estimates (latency, runtime, micro-USD estimates) are REAL because the
 *    contracts type them as plain `number`; they are not game money.
 *  - Timestamps are ISO-8601 strings (as produced by Date#toISOString).
 */
import type {
  DecisionStatus,
  LogEntry,
  RoundSource,
  RoundStatus,
  SessionMode,
  SessionPhase,
  SessionStatus,
} from '../../shared/contracts.js';
import type { LedgerEntry } from '../types.js';

// ───────────────────────────── enumerations baked into v1 CHECKs ─────────────────────────────
// FROZEN for migration 1. If a contract union gains a value, the type-level guard below fails
// typecheck; add a migration that rebuilds the affected table instead of editing these arrays.

const V1_SESSION_MODES = ['manual', 'demo', 'ai'] as const satisfies readonly SessionMode[];
const V1_SESSION_STATUSES = [
  'ready',
  'running',
  'pause_requested',
  'paused',
  'stop_requested',
  'stopped',
  'completed',
] as const satisfies readonly SessionStatus[];
const V1_SESSION_PHASES = [
  'ready',
  'requesting_decision',
  'committed',
  'outcome_recorded',
  'settled',
] as const satisfies readonly SessionPhase[];
const V1_ROUND_STATUSES = ['committed', 'outcome_recorded', 'settled'] as const satisfies readonly RoundStatus[];
const V1_ROUND_SOURCES = ['manual', 'demo', 'ai'] as const satisfies readonly RoundSource[];
const V1_LEDGER_KINDS = ['session_start', 'stake', 'payout'] as const satisfies readonly LedgerEntry['kind'][];
const V1_DECISION_STATUSES = [
  'pending',
  'accepted',
  'invalid',
  'failed',
  'stale',
  'cancelled',
  'interrupted',
  'blocked_budget',
] as const satisfies readonly DecisionStatus[];
const V1_LOG_LEVELS = ['info', 'warn', 'error'] as const satisfies readonly LogEntry['level'][];

/** Compile-time guard: every member of the contract union must be accepted by the schema. */
type Covers<Union extends string, Arr extends readonly string[]> = [Exclude<Union, Arr[number]>] extends [never]
  ? true
  : false;
type AssertTrue<T extends true> = T;
export type SchemaCoversContracts = [
  AssertTrue<Covers<SessionMode, typeof V1_SESSION_MODES>>,
  AssertTrue<Covers<SessionStatus, typeof V1_SESSION_STATUSES>>,
  AssertTrue<Covers<SessionPhase, typeof V1_SESSION_PHASES>>,
  AssertTrue<Covers<RoundStatus, typeof V1_ROUND_STATUSES>>,
  AssertTrue<Covers<RoundSource, typeof V1_ROUND_SOURCES>>,
  AssertTrue<Covers<LedgerEntry['kind'], typeof V1_LEDGER_KINDS>>,
  AssertTrue<Covers<DecisionStatus, typeof V1_DECISION_STATUSES>>,
  AssertTrue<Covers<LogEntry['level'], typeof V1_LOG_LEVELS>>,
];

/** Exposed for tests (every enum value must be storable). */
export const SCHEMA_ENUMS = {
  sessionMode: V1_SESSION_MODES,
  sessionStatus: V1_SESSION_STATUSES,
  sessionPhase: V1_SESSION_PHASES,
  roundStatus: V1_ROUND_STATUSES,
  roundSource: V1_ROUND_SOURCES,
  ledgerKind: V1_LEDGER_KINDS,
  decisionStatus: V1_DECISION_STATUSES,
  logLevel: V1_LOG_LEVELS,
} as const;

const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

// ───────────────────────────── migration 1: initial schema ─────────────────────────────

const V1 = /* sql */ `
-- Application settings and other small key → JSON values.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN (${inList(V1_SESSION_MODES)})),
  player           TEXT NOT NULL CHECK (json_valid(player)),   -- non-secret PlayerConfig
  status           TEXT NOT NULL CHECK (status IN (${inList(V1_SESSION_STATUSES)})),
  phase            TEXT NOT NULL CHECK (phase IN (${inList(V1_SESSION_PHASES)})),
  pause_reason     TEXT,
  end_reason       TEXT,
  message          TEXT,
  balance          INTEGER NOT NULL CHECK (balance >= 0),
  starting_balance INTEGER NOT NULL CHECK (starting_balance >= 0),
  rounds_played    INTEGER NOT NULL DEFAULT 0 CHECK (rounds_played >= 0),
  limits           TEXT NOT NULL CHECK (json_valid(limits)),   -- SessionLimits
  epoch            INTEGER NOT NULL DEFAULT 0,
  runtime_ms       REAL NOT NULL DEFAULT 0 CHECK (runtime_ms >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number      INTEGER NOT NULL,
  epoch             INTEGER NOT NULL,
  provider_kind     TEXT NOT NULL,
  model             TEXT,
  status            TEXT NOT NULL CHECK (status IN (${inList(V1_DECISION_STATUSES)})),
  action            TEXT CHECK (action IN ('bet', 'skip', 'stop')),
  bets              TEXT CHECK (bets IS NULL OR json_valid(bets)),   -- BetInput[] as proposed
  explanation       TEXT,
  raw_output        TEXT,
  validation_errors TEXT NOT NULL CHECK (json_valid(validation_errors)),
  error_code        TEXT,
  error_message     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  latency_ms        REAL
) STRICT;
CREATE INDEX decisions_by_session ON decisions(session_id, started_at);
CREATE INDEX decisions_pending ON decisions(started_at) WHERE status = 'pending';

-- Round lifecycle: committed → outcome_recorded → settled (forward only, see triggers).
CREATE TABLE rounds (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  status          TEXT NOT NULL CHECK (status IN (${inList(V1_ROUND_STATUSES)})),
  source          TEXT NOT NULL CHECK (source IN (${inList(V1_ROUND_SOURCES)})),
  decision_id     TEXT REFERENCES decisions(id),
  idempotency_key TEXT,
  total_stake     INTEGER NOT NULL CHECK (total_stake >= 0),
  balance_before  INTEGER NOT NULL CHECK (balance_before >= 0),
  winning_number  INTEGER CHECK (winning_number BETWEEN 0 AND 36),
  stake_returned  INTEGER CHECK (stake_returned >= 0),
  winnings        INTEGER CHECK (winnings >= 0),
  total_returned  INTEGER CHECK (total_returned >= 0),
  net             INTEGER,
  balance_after   INTEGER CHECK (balance_after >= 0),
  committed_at    TEXT NOT NULL,
  outcome_at      TEXT,
  settled_at      TEXT,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, idempotency_key),
  CHECK (total_stake <= balance_before),
  -- an outcome exists exactly when the round has left 'committed'
  CHECK ((status = 'committed') = (winning_number IS NULL)),
  CHECK ((winning_number IS NULL) = (outcome_at IS NULL)),
  -- settlement columns are all set exactly when the round is settled
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK ((status = 'settled') = (total_returned IS NOT NULL)),
  CHECK ((total_returned IS NULL) = (stake_returned IS NULL)),
  CHECK ((total_returned IS NULL) = (winnings IS NULL)),
  CHECK ((total_returned IS NULL) = (net IS NULL)),
  CHECK ((total_returned IS NULL) = (balance_after IS NULL)),
  -- settlement arithmetic
  CHECK (total_returned IS NULL OR total_returned = stake_returned + winnings),
  CHECK (net IS NULL OR net = total_returned - total_stake),
  CHECK (balance_after IS NULL OR balance_after = balance_before - total_stake + total_returned)
) STRICT;
-- At most one unsettled round per session (defence in depth for 'round_in_progress').
CREATE UNIQUE INDEX rounds_one_open_per_session ON rounds(session_id) WHERE status <> 'settled';

CREATE TRIGGER rounds_status_forward_only
BEFORE UPDATE OF status ON rounds
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'committed' AND NEW.status = 'outcome_recorded')
  OR (OLD.status = 'outcome_recorded' AND NEW.status = 'settled')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid round status transition');
END;

CREATE TRIGGER rounds_outcome_immutable
BEFORE UPDATE OF winning_number, outcome_at ON rounds
WHEN OLD.winning_number IS NOT NULL
  AND (NEW.winning_number IS NOT OLD.winning_number OR NEW.outcome_at IS NOT OLD.outcome_at)
BEGIN
  SELECT RAISE(ABORT, 'a recorded outcome is never replaced');
END;

CREATE TRIGGER rounds_settled_immutable
BEFORE UPDATE ON rounds
WHEN OLD.status = 'settled'
BEGIN
  SELECT RAISE(ABORT, 'settled rounds are immutable');
END;

CREATE TABLE round_bets (
  round_id  TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL CHECK (idx >= 0),
  key       TEXT NOT NULL,
  type      TEXT NOT NULL,
  numbers   TEXT NOT NULL CHECK (json_valid(numbers)),
  bet_index INTEGER,                                  -- ResolvedBet.index (dozen/column)
  stake     INTEGER NOT NULL CHECK (stake > 0),
  payout    INTEGER NOT NULL CHECK (payout > 0),
  label     TEXT NOT NULL,
  won       INTEGER CHECK (won IN (0, 1)),
  returned  INTEGER CHECK (returned >= 0),
  PRIMARY KEY (round_id, idx),
  UNIQUE (round_id, key),
  CHECK ((won IS NULL) = (returned IS NULL))
) STRICT;

CREATE TRIGGER round_bets_settle_once
BEFORE UPDATE ON round_bets
WHEN OLD.won IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bet results are written once');
END;

-- Append-only money ledger. SUM(amount) per session == sessions.balance.
CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_id      TEXT REFERENCES rounds(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN (${inList(V1_LEDGER_KINDS)})),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at    TEXT NOT NULL,
  CHECK (
       (kind = 'session_start' AND round_id IS NULL     AND amount >= 0)
    OR (kind = 'stake'         AND round_id IS NOT NULL AND amount < 0)
    OR (kind = 'payout'        AND round_id IS NOT NULL AND amount >= 0)
  )
) STRICT;
CREATE UNIQUE INDEX ledger_one_entry_per_round_kind ON ledger(round_id, kind) WHERE round_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_one_session_start ON ledger(session_id) WHERE kind = 'session_start';
CREATE INDEX ledger_by_session ON ledger(session_id, id);

CREATE TRIGGER ledger_append_only
BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are append-only');
END;

CREATE TABLE usage_records (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id           TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  attempt               INTEGER NOT NULL,
  provider_kind         TEXT NOT NULL,
  model                 TEXT,
  status                TEXT NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_write_tokens    INTEGER,
  reasoning_tokens      INTEGER,
  known                 INTEGER NOT NULL CHECK (known IN (0, 1)),
  latency_ms            REAL,
  generation_ms         REAL,
  output_tokens_per_sec REAL,
  cost_micros           REAL,          -- estimate in micro-USD (may be fractional); NULL = unknown
  cost_basis            TEXT NOT NULL,
  rate_limit            TEXT CHECK (rate_limit IS NULL OR json_valid(rate_limit)),
  created_at            TEXT NOT NULL
) STRICT;
CREATE INDEX usage_by_session ON usage_records(session_id, created_at);
CREATE INDEX usage_by_decision ON usage_records(decision_id);

-- Logs are not foreign-keyed so that diagnostic entries can never make a write fail.
CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN (${inList(V1_LOG_LEVELS)})),
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX logs_by_session ON logs(session_id, id);

-- Stored responses for Idempotency-Key replays of create/control requests.
CREATE TABLE idempotency (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  response   TEXT NOT NULL CHECK (json_valid(response)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;
`;

// ───────────────────────────── migration 2: provider notes on decisions ─────────────────────────────
// DecisionRecord.providerNote: a factual note from the provider adapter for the accepted attempt
// (e.g. Claude Code CLI "conversation … turn 2 (resumed)", Laya top labels / routing).
// Nullable: NULL = no note (every decision stored before this migration reads back as null).

const V2 = /* sql */ `
ALTER TABLE decisions ADD COLUMN provider_note TEXT;
`;

/** MIGRATIONS[i] upgrades user_version i → i + 1. Append only. */
export const MIGRATIONS: readonly string[] = Object.freeze([V1, V2]);

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;
