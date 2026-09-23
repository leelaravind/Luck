/**
 * SHARED CONTRACTS — the single source of truth for data exchanged between the
 * engine, persistence, session orchestration, providers, HTTP API and the UI.
 *
 * Rules that every module must respect:
 *  - Money is ALWAYS an integer number of credit subunits (100 subunits = 1 credit).
 *  - The backend is authoritative for legal bets, balances, outcomes, settlement and status.
 *  - The frontend only displays values and sends requests; it never computes an
 *    authoritative payout, edits a balance or picks a winning number.
 *  - Models only ever see a GameObservation. They never see RNG state, future
 *    outcomes, database rows, secrets or the engine itself.
 */

// ───────────────────────────── money ─────────────────────────────

/** Integer credit subunits. 100 subunits = 1 credit ("V$ 1.00"). */
export type Subunits = number;
export const SUBUNITS_PER_CREDIT = 100;

/** Micro-USD (1 USD = 1_000_000). Used for provider cost and spending budgets. */
export type UsdMicros = number;
export const MICROS_PER_USD = 1_000_000;

// ───────────────────────────── bets ─────────────────────────────

export type BetType =
  | 'straight' // 1 number, 35:1
  | 'split' // 2 adjacent numbers incl. zero splits 0-1, 0-2, 0-3, 17:1
  | 'street' // 3 numbers in a layout column (n, n+1, n+2 with n % 3 === 1), 11:1
  | 'trio' // zero trios 0-1-2 and 0-2-3, 11:1
  | 'corner' // 4 numbers in a square, 8:1
  | 'firstFour' // 0-1-2-3, 8:1
  | 'sixLine' // two adjacent streets, 5:1
  | 'dozen' // index 1..3 → 1-12, 13-24, 25-36, 2:1
  | 'column' // index 1..3 → layout rows (1,4,…,34), (2,5,…,35), (3,6,…,36), 2:1
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low' // 1-18
  | 'high'; // 19-36

/** What a player (human UI, demo player or model) submits for one bet. */
export interface BetInput {
  type: BetType;
  /** Required for straight/split/street/trio/corner/firstFour/sixLine. Order-insensitive. */
  numbers?: number[];
  /** Required for dozen/column (1, 2 or 3). */
  index?: number;
  /** Integer subunits. Must be a positive multiple of limits.stakeIncrement. */
  stake: Subunits;
}

/** A bet after backend validation. */
export interface ResolvedBet {
  /** Canonical key, e.g. "straight:17", "split:0-3", "dozen:2", "red". Identical bets share a key. */
  key: string;
  type: BetType;
  /** Covered numbers, sorted ascending. */
  numbers: number[];
  index?: number;
  stake: Subunits;
  /** "X to 1" payout ratio. */
  payout: number;
  /** Human label, e.g. "Split 0/3". */
  label: string;
}

// ───────────────────────────── session limits ─────────────────────────────

export interface SessionLimits {
  startingBalance: Subunits;
  minStake: Subunits;
  stakeIncrement: Subunits;
  maxStakePerBet: Subunits;
  /** Combined stake across ALL bets in one round. */
  maxStakePerRound: Subunits;
  maxBetsPerRound: number;
  /** null = unlimited. */
  maxRounds: number | null;
  /** Wall-clock seconds of autonomous running; null = unlimited. */
  maxRuntimeSec: number | null;
  /** Hard cap on model output tokens per request. */
  maxOutputTokens: number;
  /**
   * Optional application spending limit for PAID provider calls in micro-USD. This is an app-side
   * limit, NOT a provider quota. null = no app spending limit (the user's explicit choice; API-key
   * providers then bill every request to the user's account until the balance runs out or Stop).
   */
  budgetMicros: UsdMicros | null;
  /** Per-attempt timeout for a model decision. */
  decisionTimeoutMs: number;
  /** Retries after the first attempt for one decision (bounded). */
  maxRetries: number;
  /**
   * Consecutive failed decisions (each after its bounded retries) before the session pauses.
   * Default 1: a provider failure pauses the session right after its retries are exhausted.
   */
  maxConsecutiveFailures: number;
  /** Completed rounds included in the model observation. */
  historyWindow: number;
  /**
   * May an AI player end the session with action "stop"? Default false: play continues until the
   * balance cannot cover the minimum stake, a configured limit is reached, or the user presses Stop.
   */
  allowModelStop: boolean;
}

export const DEFAULT_LIMITS: SessionLimits = {
  startingBalance: 1_000_00,
  minStake: 10,
  stakeIncrement: 10,
  maxStakePerBet: 100_00,
  maxStakePerRound: 200_00,
  maxBetsPerRound: 10,
  // No stopping limits by default: sessions run until the balance is exhausted or the user stops.
  maxRounds: null,
  maxRuntimeSec: null,
  maxOutputTokens: 400,
  budgetMicros: null, // no app spending limit unless the user sets one
  decisionTimeoutMs: 60_000,
  maxRetries: 2,
  maxConsecutiveFailures: 1,
  historyWindow: 20,
  allowModelStop: false,
};

// ───────────────────────────── players / providers ─────────────────────────────

export type PlayerKind = 'manual' | 'demo' | 'ollama' | 'anthropic' | 'openai' | 'claude-cli' | 'laya';
export type AiProviderKind = Exclude<PlayerKind, 'manual' | 'demo'>;
export const AI_PROVIDER_KINDS: readonly AiProviderKind[] = ['ollama', 'anthropic', 'openai', 'claude-cli', 'laya'];

export type SessionMode = 'manual' | 'demo' | 'ai';

/** Per-MTok pricing assumption used ONLY for estimated cost. Always labelled as an estimate. */
export interface Pricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
  /** Where the numbers came from: typed by the user, or a documented default assumption. */
  source: 'user' | 'default-assumption';
  /** ISO date the assumption was recorded. */
  asOf?: string;
}

/** Non-secret player configuration (safe to store, export and send to the browser). */
export interface PlayerConfig {
  kind: PlayerKind;
  /** Model identifier as the provider expects it. Never hardcoded in the UI; chosen/typed by the user. */
  model?: string;
  /** Endpoint for ollama / openai-compatible / laya. Secrets are never part of this object. */
  baseUrl?: string;
  temperature?: number;
  pricing?: Pricing;
  /** Laya checkpoint name (english | multilingual | typed-decisions). */
  layaCheckpoint?: string;
}

export interface ProviderCapabilities {
  kind: PlayerKind;
  label: string;
  /** Runs on this machine (no cloud inference charge). */
  local: boolean;
  /** May incur provider charges; budget enforcement applies. */
  paid: boolean;
  /** false for classifiers such as Laya (no generated text, no output tokens). */
  generatesText: boolean;
  reportsTokenUsage: 'full' | 'input-only' | 'none';
  /** Provider reports its own cost figure (e.g. Claude Code CLI total_cost_usd). */
  reportsCost: boolean;
  listsModels: boolean;
  structuredOutput: boolean;
  /** What quota/rate-limit information the provider actually exposes. */
  quotaInfo: 'rate-limit-headers' | 'rate-limit-events' | 'none';
  requiresApiKey: boolean;
  /** Short honest notes shown in the UI (e.g. "Subscription usage is not reported per call"). */
  notes: string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  testedAt: string;
  latencyMs: number | null;
  message: string;
  version?: string;
  models?: string[];
}

export interface ProviderStatus {
  kind: AiProviderKind;
  capabilities: ProviderCapabilities;
  /** Required configuration present (e.g. API key in server env, CLI binary found). */
  configured: boolean;
  /** Adapter can be selected at all (e.g. CLI boundary enforceable). */
  enabled: boolean;
  issues: string[];
  /** Non-secret defaults from server config (base URL, default model if the user set one in .env). */
  defaults: Pick<PlayerConfig, 'baseUrl' | 'model' | 'layaCheckpoint'>;
  lastTest: ConnectionTestResult | null;
}

// ───────────────────────────── observation & decision ─────────────────────────────

export interface ObservedRound {
  round: number;
  winningNumber: number;
  color: 'red' | 'black' | 'green';
  yourBets: { type: BetType; numbers?: number[]; index?: number; stake: Subunits }[];
  yourTotalStake: Subunits;
  yourNet: Subunits;
}

/**
 * EVERYTHING a model is allowed to know. Built only from committed, settled history.
 * Must never contain RNG state, seeds, pending/future outcomes, ids of internal rows, or secrets.
 */
export interface GameObservation {
  schemaVersion: 1;
  game: 'european-roulette-single-zero';
  /** The upcoming round number (1-based). */
  roundNumber: number;
  balance: Subunits;
  units: string;
  limits: {
    minStake: Subunits;
    stakeIncrement: Subunits;
    maxStakePerBet: Subunits;
    maxStakePerRound: Subunits;
    maxBetsPerRound: number;
    roundsRemaining: number | null;
  };
  betTypes: { type: BetType; payout: number; selection: string }[];
  rules: string[];
  history: ObservedRound[];
  stats: { roundsPlayed: number; netResult: Subunits };
}

/** "strategy" is the player's own short name for the approach it says it follows (unverified). */
export type PlayerDecision =
  | { action: 'bet'; bets: BetInput[]; strategy?: string; explanation?: string }
  | { action: 'skip'; strategy?: string; explanation?: string }
  | { action: 'stop'; strategy?: string; explanation?: string };

/** Max characters of the stated strategy kept/displayed. */
export const MAX_STRATEGY_CHARS = 120;

/** Max characters of the optional explanation kept/displayed. */
export const MAX_EXPLANATION_CHARS = 400;
/** Max characters of raw provider output stored for inspection. */
export const MAX_RAW_OUTPUT_CHARS = 4000;

// ───────────────────────────── rounds ─────────────────────────────

/**
 * Round lifecycle (explicit, persisted):
 *   committed        bets saved + stakes deducted (outcome NOT yet drawn)
 *   outcome_recorded winning number drawn from the secure RNG and saved
 *   settled          returns credited exactly once
 * The session "phase" additionally shows ready / requesting_decision.
 * Wheel animation is presentation only and never part of this lifecycle.
 */
export type RoundStatus = 'committed' | 'outcome_recorded' | 'settled';
export type RoundSource = 'manual' | 'demo' | 'ai';

export interface RoundBet {
  key: string;
  type: BetType;
  numbers: number[];
  index?: number;
  stake: Subunits;
  payout: number;
  label: string;
  /** null until settled. */
  won: boolean | null;
  /** Stake returned + winnings for this bet (0 if lost); null until settled. */
  returned: Subunits | null;
}

export interface RoundRecord {
  id: string;
  sessionId: string;
  /** 1-based sequence within the session. */
  seq: number;
  status: RoundStatus;
  source: RoundSource;
  decisionId: string | null;
  bets: RoundBet[];
  totalStake: Subunits;
  balanceBefore: Subunits;
  winningNumber: number | null;
  /** Sum of stakes on winning bets that is handed back. */
  stakeReturned: Subunits | null;
  /** Profit on winning bets (stake × payout), excluding the returned stake. */
  winnings: Subunits | null;
  /** stakeReturned + winnings. */
  totalReturned: Subunits | null;
  /** Net round result = totalReturned − totalStake. */
  net: Subunits | null;
  balanceAfter: Subunits | null;
  committedAt: string;
  outcomeAt: string | null;
  settledAt: string | null;
}

export interface Settlement {
  winningNumber: number;
  totalStake: Subunits;
  stakeReturned: Subunits;
  winnings: Subunits;
  totalReturned: Subunits;
  net: Subunits;
  bets: { key: string; won: boolean; returned: Subunits }[];
}

// ───────────────────────────── decisions & usage ─────────────────────────────

export type DecisionStatus =
  | 'pending' // request in flight
  | 'accepted' // valid, applied
  | 'invalid' // output failed schema/rules validation after retries
  | 'failed' // provider error after bounded retries
  | 'stale' // arrived after stop/reset/epoch change; discarded
  | 'cancelled' // aborted by Stop
  | 'interrupted' // server restarted mid-request
  | 'blocked_budget'; // not sent because the remaining budget could not cover it

export interface DecisionRecord {
  id: string;
  sessionId: string;
  /** Round number the decision was requested for. */
  roundNumber: number;
  epoch: number;
  providerKind: PlayerKind;
  model: string | null;
  status: DecisionStatus;
  action: 'bet' | 'skip' | 'stop' | null;
  bets: BetInput[] | null;
  explanation: string | null;
  rawOutput: string | null;
  validationErrors: string[];
  errorCode: ProviderErrorCode | null;
  errorMessage: string | null;
  attempts: number;
  startedAt: string;
  completedAt: string | null;
  latencyMs: number | null;
}

export interface UsageNumbers {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** false when the provider did not report usage for this attempt (e.g. timeout, crash). */
  known: boolean;
}

export type CostBasis =
  | 'provider-reported' // e.g. Claude Code CLI total_cost_usd (itself an estimate by the CLI)
  | 'estimated-from-pricing' // tokens × user/default pricing assumption
  | 'local-no-charge' // local inference (Ollama, Laya)
  | 'unknown' // usage or pricing unknown
  | 'not-applicable'; // demo player

export interface RateLimitInfo {
  source: 'response-headers' | 'cli-rate-limit-event';
  capturedAt: string;
  entries: {
    name: string;
    limit?: number;
    remaining?: number;
    resetAt?: string;
    utilization?: number;
    status?: string;
  }[];
}

export type UsageAttemptStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_output'
  | 'cancelled'
  | 'stale';

export interface UsageRecord extends UsageNumbers {
  id: string;
  sessionId: string;
  decisionId: string;
  attempt: number;
  providerKind: PlayerKind;
  model: string | null;
  status: UsageAttemptStatus;
  latencyMs: number | null;
  /** Pure generation time when the provider reports it (Ollama eval_duration). */
  generationMs: number | null;
  /** outputTokens / generation seconds (or end-to-end seconds when generationMs is null); null if unknown. */
  outputTokensPerSec: number | null;
  costMicros: UsdMicros | null;
  costBasis: CostBasis;
  rateLimit: RateLimitInfo | null;
  createdAt: string;
}

export interface UsageSummary {
  requests: number;
  failedRequests: number;
  unknownUsageRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Sum of known costs. */
  costMicros: UsdMicros;
  /** True when at least one paid attempt had unknown cost. */
  costIsPartial: boolean;
  costBasis: CostBasis;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  lastOutputTokensPerSec: number | null;
  budgetMicros: UsdMicros | null;
  budgetRemainingMicros: UsdMicros | null;
  lastRateLimit: RateLimitInfo | null;
}

// ───────────────────────────── sessions ─────────────────────────────

export type SessionStatus =
  | 'ready' // created / manual play possible / autonomous not started
  | 'running' // autonomous loop active
  | 'pause_requested' // finish current round, then pause
  | 'paused'
  | 'stop_requested' // cancel decision, settle committed round, then stop
  | 'stopped' // terminal
  | 'completed'; // terminal: a limit was reached

export type SessionPhase = 'ready' | 'requesting_decision' | 'committed' | 'outcome_recorded' | 'settled';

export type SessionEndReason =
  | 'user_stop'
  | 'max_rounds'
  | 'max_runtime'
  | 'budget_exhausted'
  | 'insufficient_balance'
  | 'model_stop';

export type PauseReason =
  | 'user_pause'
  | 'step_complete'
  | 'provider_error'
  | 'invalid_output'
  | 'rate_limited'
  | 'server_restart';

export interface SessionInfo {
  id: string;
  name: string;
  mode: SessionMode;
  player: PlayerConfig;
  status: SessionStatus;
  phase: SessionPhase;
  pauseReason: PauseReason | null;
  endReason: SessionEndReason | null;
  /** Latest human-readable status/error message (never contains secrets). */
  message: string | null;
  balance: Subunits;
  startingBalance: Subunits;
  roundsPlayed: number;
  limits: SessionLimits;
  /** Incremented on stop / reset / session change; responses from older epochs are stale. */
  epoch: number;
  createdAt: string;
  updatedAt: string;
  /** Accumulated autonomous running time. */
  runtimeMs: number;
}

export interface SessionSnapshot {
  session: SessionInfo;
  /** Latest round (any status). */
  currentRound: RoundRecord | null;
  /** Last settled rounds, newest first (max 20). */
  recentRounds: RoundRecord[];
  lastDecision: DecisionRecord | null;
  usage: UsageSummary;
  inFlight: { decision: boolean; round: boolean };
}

export interface LogEntry {
  id: number;
  sessionId: string;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  createdAt: string;
}

// ───────────────────────────── app settings ─────────────────────────────

export type AnimationSpeed = 'normal' | 'fast' | 'instant';

export interface AppSettings {
  defaultLimits: SessionLimits;
  /** Presentation only. Never changes how often models are called. */
  animationSpeed: AnimationSpeed;
  reduceMotion: 'system' | 'on' | 'off';
  /** Pricing assumptions keyed by `${kind}:${model}`. */
  pricing: Record<string, Pricing>;
  /** Last-used non-secret player configs per provider. */
  players: Partial<Record<AiProviderKind, PlayerConfig>>;
}

// ───────────────────────────── errors ─────────────────────────────

export type ApiErrorCode =
  | 'validation_error'
  | 'invalid_bet'
  | 'insufficient_funds'
  | 'limit_exceeded'
  | 'round_in_progress'
  | 'decision_in_flight'
  | 'invalid_state'
  | 'not_found'
  | 'duplicate_request'
  | 'forbidden'
  | 'provider_unavailable'
  | 'budget_exhausted'
  | 'internal';

/** Every non-2xx API response body. */
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

export type ProviderErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable' // connection refused / DNS / service down
  | 'auth'
  | 'bad_request'
  | 'server_error'
  | 'invalid_output'
  | 'cancelled'
  | 'budget'
  | 'boundary_violation' // e.g. CLI attempted tool use
  | 'not_configured'
  | 'unknown';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus?: number;
}

/** Thrown by domain code; HTTP layer maps it to ApiErrorBody. */
export class GameError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

export const HTTP_STATUS_FOR: Record<ApiErrorCode, number> = {
  validation_error: 400,
  invalid_bet: 422,
  insufficient_funds: 422,
  limit_exceeded: 422,
  round_in_progress: 409,
  decision_in_flight: 409,
  invalid_state: 409,
  not_found: 404,
  duplicate_request: 409,
  forbidden: 403,
  provider_unavailable: 503,
  budget_exhausted: 402,
  internal: 500,
};

// ───────────────────────────── HTTP API ─────────────────────────────
/*
 * All state-changing requests (POST/PUT/PATCH/DELETE) MUST send:
 *   - header  X-Luck-Client: 1          (forces CORS preflight → cross-origin requests fail)
 *   - header  Idempotency-Key: <uuid>   (required on POST /api/sessions, /rounds, /control)
 *   - Content-Type: application/json
 * Replaying an Idempotency-Key returns the original response and has no further effect.
 *
 * GET  /api/health                                   → { ok: true, version }
 * GET  /api/providers                                → { providers: ProviderStatus[] }
 * POST /api/providers/:kind/test   { player?: PlayerConfig }      → ConnectionTestResult
 * POST /api/providers/:kind/models { player?: PlayerConfig }      → { models: string[] }
 * GET  /api/settings                                 → AppSettings
 * PUT  /api/settings               Partial<AppSettings>           → AppSettings
 * GET  /api/sessions                                 → { sessions: SessionInfo[] }
 * POST /api/sessions               CreateSessionRequest           → SessionSnapshot
 * GET  /api/sessions/:id                             → SessionSnapshot
 * POST /api/sessions/:id/rounds    { bets: BetInput[] }           → ManualRoundResponse   (manual mode)
 * POST /api/sessions/:id/control   { action: ControlAction }      → SessionSnapshot
 * GET  /api/sessions/:id/rounds?limit=&beforeSeq=    → { rounds: RoundRecord[] }  (newest first)
 * GET  /api/sessions/:id/decisions?limit=            → { decisions: DecisionRecord[] }
 * GET  /api/sessions/:id/usage                       → { records: UsageRecord[]; summary: UsageSummary }
 * GET  /api/sessions/:id/logs?limit=                 → { logs: LogEntry[] }
 * GET  /api/sessions/:id/export?format=json|csv      → file download (no secrets)
 * GET  /api/events?sessionId=                        → text/event-stream of ServerEvent
 */

export interface CreateSessionRequest {
  name?: string;
  player: PlayerConfig;
  limits?: Partial<SessionLimits>;
}

export type ControlAction = 'start' | 'pause' | 'stop' | 'step';

export interface ManualRoundResponse {
  round: RoundRecord;
  snapshot: SessionSnapshot;
}

export type ServerEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'round'; round: RoundRecord }
  | { type: 'decision'; decision: DecisionRecord }
  | { type: 'usage'; usage: UsageRecord }
  | { type: 'log'; log: LogEntry }
  | { type: 'heartbeat'; at: string };
