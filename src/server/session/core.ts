/**
 * Internal context shared by the session modules (service, runner, AI decisions, recovery).
 * Not part of the public GameService contract.
 */
import type {
  AiProviderKind,
  AppSettings,
  DecisionRecord,
  LogEntry,
  RoundRecord,
  ServerEvent,
  SessionInfo,
  UsageRecord,
} from '../../shared/contracts.js';
import type { AppConfig, DemoPlayer, OutcomeSource, ProviderAdapter, Repository, SessionPatch } from '../types.js';
import type { RoundFlowDeps } from './roundFlow.js';

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface SessionCore {
  readonly config: AppConfig;
  readonly repo: Repository;
  readonly adapters: Map<AiProviderKind, ProviderAdapter>;
  readonly outcomeSource: OutcomeSource;
  readonly demoPlayer: DemoPlayer;
  now(): Date;
  nowIso(): string;
  sleep: SleepFn;
  /**
   * Server wait between autonomous rounds for the current settings. Production: settings.roundPacingMs
   * (independent of the animation speed, which is presentation only). Injectable for tests.
   */
  presentationDelayMs(settings: AppSettings): number;
  settings(): AppSettings;

  /** Round flow wiring (repo + outcome source + event emission). */
  readonly roundDeps: RoundFlowDeps;

  emit(sessionId: string, ev: ServerEvent): void;
  emitSnapshot(sessionId: string): void;
  emitRound(round: RoundRecord): void;

  /** Persist + emit. Messages are redacted before they are stored. */
  log(sessionId: string, level: LogEntry['level'], type: string, message: string): void;
  updateSession(id: string, patch: SessionPatch): SessionInfo;
  insertDecision(rec: DecisionRecord): DecisionRecord;
  updateDecision(id: string, patch: Partial<DecisionRecord>): DecisionRecord;
  insertUsage(rec: UsageRecord): UsageRecord;

  /**
   * Register a provider promise the runner stopped waiting for (Stop, shutdown or watchdog).
   * `onSettle(result | null)` runs exactly once: with the late result, or with null when it never
   * arrives (give-up timer or shutdown flush). While outstanding it counts toward the budget.
   */
  trackLate<T>(sessionId: string, promise: Promise<T>, onSettle: (value: T | null) => void): void;
  /** Late attempts still outstanding for a session (budget pre-check counts them as worst case). */
  outstandingAttempts(sessionId: string): number;
}

/** Idle phase after a round (or before the first one). */
export function idlePhase(repo: Repository, sessionId: string): SessionInfo['phase'] {
  const latest = repo.getLatestRound(sessionId);
  if (!latest) return 'ready';
  return latest.status === 'settled' ? 'settled' : latest.status;
}
