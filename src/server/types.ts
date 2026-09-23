/**
 * SERVER-SIDE CONTRACTS between persistence (db/), engine/, providers/, session/ and http/.
 * Types shared with the browser live in ../shared/contracts.ts.
 */
import type {
  AiProviderKind,
  AppSettings,
  AppSettingsPatch,
  ConnectionTestResult,
  ControlAction,
  CreateSessionRequest,
  DecisionRecord,
  GameObservation,
  LogEntry,
  ManualRoundResponse,
  PlayerConfig,
  PlayerKind,
  ProviderCapabilities,
  ProviderError,
  ProviderStatus,
  RateLimitInfo,
  ResolvedBet,
  RoundRecord,
  RoundSource,
  ServerEvent,
  SessionInfo,
  SessionLimits,
  SessionMode,
  SessionSnapshot,
  Settlement,
  Subunits,
  UsageNumbers,
  UsageRecord,
  UsageSummary,
  BetInput,
} from '../shared/contracts.js';

// ───────────────────────────── config (src/server/config.ts) ─────────────────────────────

export interface AppConfig {
  version: string;
  /** Always a loopback address. */
  host: string;
  port: number;
  /** Extra allowed browser origins (the Vite dev server in development). */
  devOrigins: string[];
  isDev: boolean;
  dataDir: string;
  dbPath: string;
  /** Absolute path of built frontend (dist/web) served in production. */
  webDistDir: string;
  providers: {
    ollama: { baseUrl: string; model?: string };
    anthropic: { apiKey?: string; baseUrl: string; model?: string };
    openai: { apiKey?: string; baseUrl?: string; model?: string };
    claudeCli: { path?: string; enabled: boolean; model?: string; useSubscriptionAuth: boolean };
    laya: { baseUrl: string; apiKey?: string; checkpoint: string };
  };
}

// ───────────────────────────── engine (src/server/engine/) ─────────────────────────────

/** Source of winning numbers. Production = crypto.randomInt. Tests inject fixtures. */
export interface OutcomeSource {
  /** Uniform integer in [0, 36]. Called ONLY after the round's bets are committed. */
  next(): number;
  readonly kind: 'crypto' | 'fixture';
}

// ───────────────────────────── persistence (src/server/db/) ─────────────────────────────

export interface LedgerEntry {
  id: number;
  sessionId: string;
  roundId: string | null;
  kind: 'session_start' | 'stake' | 'payout';
  /** Signed subunits (stake is negative, payout positive). */
  amount: Subunits;
  balanceAfter: Subunits;
  createdAt: string;
}

export interface SessionExport {
  exportedAt: string;
  app: { name: string; version: string };
  notice: string;
  session: SessionInfo;
  rounds: RoundRecord[];
  decisions: DecisionRecord[];
  usage: UsageRecord[];
  ledger: LedgerEntry[];
  logs: LogEntry[];
}

export interface NewSession {
  id: string;
  name: string;
  mode: SessionMode;
  player: PlayerConfig;
  limits: SessionLimits;
  createdAt: string;
}

export type SessionPatch = Partial<
  Pick<
    SessionInfo,
    'name' | 'status' | 'phase' | 'pauseReason' | 'endReason' | 'message' | 'epoch' | 'runtimeMs' | 'player' | 'limits'
  >
>;

/**
 * Every method is synchronous (node:sqlite DatabaseSync). Methods marked [TX] run in a single
 * BEGIN IMMEDIATE transaction and either fully apply or throw GameError without side effects.
 */
export interface Repository {
  // sessions
  /** [TX] insert session with balance = limits.startingBalance + ledger 'session_start'. */
  createSession(input: NewSession): SessionInfo;
  /**
   * [TX] Create a session AND its idempotency record atomically (record = { sessionId, fingerprint }
   * under (scope, key)). If (scope, key) already exists, nothing is written and the existing session
   * is returned with created=false and the stored fingerprint, so the caller can reject a mismatch.
   */
  createSessionIdempotent(
    input: NewSession,
    idem: { scope: string; key: string; fingerprint: string },
  ): { session: SessionInfo; created: boolean; fingerprint: string };
  getSession(id: string): SessionInfo | null;
  listSessions(): SessionInfo[];
  updateSession(id: string, patch: SessionPatch): SessionInfo;

  // rounds
  /**
   * [TX] Commit bets. Throws GameError('round_in_progress') if the session has a round that is not
   * settled; GameError('insufficient_funds') if balance < total stake. Assigns seq = last seq + 1,
   * inserts round + bets with status 'committed', deducts total stake, writes ledger 'stake'.
   * If idempotencyKey was already used in this session, returns that round unchanged (no charge).
   */
  commitRound(input: {
    id: string;
    sessionId: string;
    source: RoundSource;
    decisionId: string | null;
    bets: ResolvedBet[];
    idempotencyKey: string | null;
    committedAt: string;
  }): RoundRecord;
  /**
   * [TX] committed → outcome_recorded. If the round already has an outcome it is returned
   * unchanged (an existing outcome is NEVER replaced). Throws if round missing.
   */
  recordOutcome(roundId: string, winningNumber: number, at: string): RoundRecord;
  /**
   * [TX] outcome_recorded → settled. Credits settlement.totalReturned, writes ledger 'payout'
   * (UNIQUE per round), increments session roundsPlayed. Returns applied=false and changes
   * nothing if the round is already settled. Throws if settlement.winningNumber differs from stored.
   */
  settleRound(roundId: string, settlement: Settlement, at: string): { round: RoundRecord; applied: boolean };
  getRound(id: string): RoundRecord | null;
  getLatestRound(sessionId: string): RoundRecord | null;
  /** Newest first. */
  listRounds(sessionId: string, opts?: { limit?: number; beforeSeq?: number }): RoundRecord[];
  findRoundByIdempotencyKey(sessionId: string, key: string): RoundRecord | null;
  /** All rounds in status committed/outcome_recorded across sessions (startup recovery). */
  findUnsettledRounds(): RoundRecord[];

  // decisions
  insertDecision(rec: DecisionRecord): void;
  updateDecision(id: string, patch: Partial<DecisionRecord>): DecisionRecord;
  getDecision(id: string): DecisionRecord | null;
  /** Newest first. */
  listDecisions(sessionId: string, limit?: number): DecisionRecord[];
  findPendingDecisions(): DecisionRecord[];

  // usage
  insertUsage(rec: UsageRecord): void;
  /** Oldest first. */
  listUsage(sessionId: string): UsageRecord[];

  // logs
  appendLog(sessionId: string, level: LogEntry['level'], type: string, message: string): LogEntry;
  /** Newest first. */
  listLogs(sessionId: string, limit?: number): LogEntry[];

  // ledger
  listLedger(sessionId: string): LedgerEntry[];

  // idempotency for create/control requests (rounds use commitRound's key)
  getIdempotent(scope: string, key: string): unknown | null;
  putIdempotent(scope: string, key: string, response: unknown): void;

  // settings (JSON values)
  getSetting<T>(key: string): T | null;
  putSetting(key: string, value: unknown): void;

  exportSession(sessionId: string): SessionExport;
  close(): void;
}

// ───────────────────────────── providers (src/server/providers/) ─────────────────────────────

/** Player config plus SERVER-ONLY values (secrets, binary paths). Never serialised to the browser. */
export interface ResolvedProviderConfig extends PlayerConfig {
  apiKey?: string;
  cliPath?: string;
  useSubscriptionAuth?: boolean;
}

export interface DecisionRequest {
  observation: GameObservation;
  systemPrompt: string;
  /** JSON observation + instructions. */
  userPrompt: string;
  /** JSON Schema of PlayerDecision (for providers with structured output). */
  jsonSchema: Record<string, unknown>;
  model: string | undefined;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  /** Remaining app budget in USD for this call (Claude Code CLI --max-budget-usd). null = none. */
  maxBudgetUsd: number | null;
  /**
   * Stable key of the Luck session making the request. Providers that keep a conversation open
   * (Claude Code CLI: one resumed conversation per Luck session) use it; others ignore it.
   */
  conversationKey?: string;
}

export interface ProviderCallResult {
  ok: boolean;
  /** Raw model text (or raw JSON body for classifiers). Null when nothing was returned. */
  text: string | null;
  /** Already-parsed object when the provider returns structured output (or Laya's mapped decision). */
  structured?: unknown;
  usage: UsageNumbers;
  latencyMs: number;
  generationMs: number | null;
  /** Cost figure reported by the provider itself (e.g. CLI total_cost_usd), USD. */
  providerCostUsd: number | null;
  modelReported: string | null;
  finishReason: string | null;
  rateLimit: RateLimitInfo | null;
  error: ProviderError | null;
  /** Extra factual info for the UI, e.g. Laya label probabilities. */
  note?: string;
}

/**
 * Adapters NEVER throw for provider/network problems: they return ok:false with a typed
 * ProviderError. They honour the AbortSignal and req.timeoutMs. They do not retry — the
 * session runner owns bounded retries and budget checks between attempts.
 */
export interface ProviderAdapter {
  readonly kind: AiProviderKind;
  readonly capabilities: ProviderCapabilities;
  /** Static configuration check (no network). */
  check(cfg: ResolvedProviderConfig): { configured: boolean; enabled: boolean; issues: string[] };
  testConnection(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ConnectionTestResult>;
  listModels?(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<string[]>;
  decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult>;
}

/** Rule-based demo player (not AI). Pure and synchronous. */
export interface DemoPlayer {
  decide(obs: GameObservation): { action: 'bet' | 'skip' | 'stop'; bets?: BetInput[]; explanation: string };
}

// ───────────────────────────── session service (src/server/session/) ─────────────────────────────

export interface GameService {
  listProviders(): ProviderStatus[];
  testProvider(kind: AiProviderKind, player?: PlayerConfig): Promise<ConnectionTestResult>;
  listModels(kind: AiProviderKind, player?: PlayerConfig): Promise<string[]>;

  getSettings(): AppSettings;
  updateSettings(patch: AppSettingsPatch): AppSettings;

  listSessions(): SessionInfo[];
  createSession(req: CreateSessionRequest, idempotencyKey: string): SessionSnapshot;
  getSnapshot(sessionId: string): SessionSnapshot;
  /** Manual mode only. Validates, commits, draws outcome, settles — all before returning. */
  placeManualRound(sessionId: string, bets: BetInput[], idempotencyKey: string): ManualRoundResponse;
  control(sessionId: string, action: ControlAction, idempotencyKey: string): Promise<SessionSnapshot>;

  listRounds(sessionId: string, opts?: { limit?: number; beforeSeq?: number }): RoundRecord[];
  listDecisions(sessionId: string, limit?: number): DecisionRecord[];
  getUsage(sessionId: string): { records: UsageRecord[]; summary: UsageSummary };
  listLogs(sessionId: string, limit?: number): LogEntry[];
  exportSession(sessionId: string, format: 'json' | 'csv'): { filename: string; contentType: string; body: string };

  /** Subscribe to events for one session. Returns unsubscribe. */
  subscribe(sessionId: string, listener: (ev: ServerEvent) => void): () => void;

  /** Startup: settle recoverable rounds (never redraw an existing outcome), pause running sessions, mark pending decisions interrupted. */
  recover(): { settledRounds: number; pausedSessions: number; interruptedDecisions: number };
  shutdown(): Promise<void>;
}

export type { PlayerKind, SessionLimits };
