/**
 * GameService implementation: composes persistence, the round flow, the autonomous runner,
 * providers, settings, usage and events. The HTTP layer (src/server/http) calls only this.
 *
 * The backend is authoritative: every bet is validated here, every outcome is drawn here (only
 * after the bets are committed) and every balance change goes through the repository ledger.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  AI_PROVIDER_KINDS,
  GameError,
  type AiProviderKind,
  type AppSettings,
  type BetInput,
  type ConnectionTestResult,
  type ControlAction,
  type CostBasis,
  type CreateSessionRequest,
  type DecisionRecord,
  type LogEntry,
  type ManualRoundResponse,
  type PlayerConfig,
  type ProviderCapabilities,
  type ProviderStatus,
  type RoundRecord,
  type ServerEvent,
  type SessionInfo,
  type SessionMode,
  type SessionSnapshot,
  type UsageRecord,
  type UsageSummary,
} from '../../shared/contracts.js';
import { betKey, validateBetSlip } from '../../shared/bets.js';
import { formatCredits } from '../../shared/money.js';
import { createCryptoOutcomeSource } from '../engine/rng.js';
import { toCsvExport, toJsonExport } from '../db/export.js';
import { redact } from '../redact.js';
import { createDefaultAdapters, providerDefaults, resolveProviderConfig, serverGate } from '../providers/registry.js';
import type { AppConfig, GameService, OutcomeSource, ProviderAdapter, Repository, SessionExport, SessionPatch } from '../types.js';
import { LATE_GIVE_UP_MS, sessionPricing } from './aiDecision.js';
import { idlePhase, type SessionCore, type SleepFn } from './core.js';
import { createDemoPlayer, DEMO_PLAYER_LABEL } from './demoPlayer.js';
import { createEventHub } from './events.js';
import { playRound, settleStoredRound, type RoundFlowDeps } from './roundFlow.js';
import { defaultSleep } from './retry.js';
import { createRunnerManager } from './runner.js';
import {
  loadSettings,
  rememberPlayer,
  saveSettings,
  validateCreateSessionRequest,
  validateLimits,
  validatePlayerConfig,
} from './settings.js';
import { summarizeUsage } from './usage.js';

/**
 * Server wait between autonomous rounds: the user's roundPacingMs setting. Deliberately NOT derived
 * from the animation speed (presentation only), so the animation never changes how often a model is
 * asked for a decision.
 */
export function defaultRoundPacingMs(settings: AppSettings): number {
  return settings.roundPacingMs;
}

/** Timeout for connection tests / model listing started from the UI. */
const PROVIDER_META_TIMEOUT_MS = 20_000;
/** How long shutdown() waits for runners / late results. */
const SHUTDOWN_WAIT_MS = 3_000;
const MAX_IDEMPOTENCY_KEY = 200;
/** Idempotency scope of POST /api/sessions. */
const CREATE_SESSION_SCOPE = 'create-session';
const RECENT_ROUNDS = 20;
const CONTROL_ACTIONS: readonly ControlAction[] = ['start', 'pause', 'stop', 'step'];

export interface GameServiceDeps {
  config: AppConfig;
  repo: Repository;
  adapters?: Map<AiProviderKind, ProviderAdapter>;
  outcomeSource?: OutcomeSource;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Wait between autonomous rounds for the given settings (tests inject 0); default roundPacingMs. */
  presentationDelayMs?: (settings: AppSettings) => number;
}

function modeFor(kind: PlayerConfig['kind']): SessionMode {
  if (kind === 'manual') return 'manual';
  if (kind === 'demo') return 'demo';
  return 'ai';
}

function requireKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY) {
    throw new GameError('validation_error', 'A non-empty Idempotency-Key (max 200 characters) is required');
  }
  return key;
}

function isAiKind(kind: unknown): kind is AiProviderKind {
  return typeof kind === 'string' && (AI_PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** Capabilities placeholder for a provider whose adapter is not loaded (shown as unavailable, never as working). */
function missingCapabilities(kind: AiProviderKind): ProviderCapabilities {
  return {
    kind,
    label: kind,
    local: kind === 'ollama' || kind === 'laya',
    paid: kind === 'anthropic' || kind === 'openai' || kind === 'claude-cli',
    generatesText: kind !== 'laya',
    reportsTokenUsage: 'none',
    reportsCost: false,
    listsModels: false,
    structuredOutput: false,
    quotaInfo: 'none',
    requiresApiKey: false,
    notes: ['Adapter not available in this build'],
  };
}

/** JSON with object keys sorted at every level (undefined members dropped): a stable text form of a value. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Fingerprint of a VALIDATED create-session request (name, player, limits as sent — before the
 * settings defaults are merged, so a retry stays a replay even if the defaults change meanwhile).
 */
export function createSessionFingerprint(req: CreateSessionRequest): string {
  const name = typeof req.name === 'string' && req.name.length > 0 ? req.name : null;
  return createHash('sha256').update(canonicalJson({ name, player: req.player, limits: req.limits ?? {} })).digest('hex');
}

/** Mask secrets in every text field of a decision (defence in depth: callers redact too). */
function redactDecisionText<T extends Partial<DecisionRecord>>(d: T): T {
  const out: T = { ...d };
  for (const k of ['explanation', 'rawOutput', 'errorMessage', 'providerNote'] as const) {
    const v = out[k];
    if (typeof v === 'string') (out as Partial<DecisionRecord>)[k] = redact(v);
  }
  if (Array.isArray(out.validationErrors)) out.validationErrors = out.validationErrors.map((e) => redact(String(e)));
  return out;
}

/**
 * Mask secrets in the provider-supplied text of a usage record before it is stored or emitted: the
 * model the provider reported (an echoing provider can put anything there) and the rate-limit
 * header names / values.
 */
function redactUsageRecord(rec: UsageRecord): UsageRecord {
  const clean: UsageRecord = { ...rec, model: typeof rec.model === 'string' ? redact(rec.model) : null };
  if (rec.rateLimit) {
    clean.rateLimit = {
      ...rec.rateLimit,
      entries: rec.rateLimit.entries.map((e) => {
        const out = { ...e, name: redact(String(e.name)) };
        if (typeof e.status === 'string') out.status = redact(e.status);
        if (typeof e.resetAt === 'string') out.resetAt = redact(e.resetAt);
        return out;
      }),
    };
  }
  return clean;
}

/** Mask secrets in every provider-supplied string of a connection test (message, version, model ids). */
function redactConnectionTest(result: ConnectionTestResult): ConnectionTestResult {
  const clean: ConnectionTestResult = { ...result, message: redact(String(result.message ?? '')) };
  if (typeof result.version === 'string') clean.version = redact(result.version);
  else delete clean.version;
  if (Array.isArray(result.models)) clean.models = result.models.map((m) => redact(String(m)));
  else delete clean.models;
  return clean;
}


/** Canonical "key=stake" signature of a bet slip (identical positions merged), or null when unreadable. */
function slipSignature(bets: readonly { key?: string; stake: number }[] | unknown): string | null {
  if (!Array.isArray(bets)) return null;
  const merged = new Map<string, number>();
  try {
    for (const b of bets as { key?: string; stake: number; type: BetInput['type']; numbers?: number[]; index?: number }[]) {
      const k = typeof b.key === 'string' ? b.key : betKey(b);
      merged.set(k, (merged.get(k) ?? 0) + b.stake);
    }
  } catch {
    return null;
  }
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',');
}

export function createGameService(deps: GameServiceDeps): GameService {
  const { config, repo } = deps;
  const adapters = deps.adapters ?? createDefaultAdapters();
  const outcomeSource = deps.outcomeSource ?? createCryptoOutcomeSource();
  const now = deps.now ?? (() => new Date());
  const sleep: SleepFn = deps.sleep ?? defaultSleep;
  const presentationDelayMs = deps.presentationDelayMs ?? defaultRoundPacingMs;
  const hub = createEventHub();
  const demoPlayer = createDemoPlayer();
  const lastTests = new Map<AiProviderKind, ConnectionTestResult>();

  // Late (abandoned) provider attempts: settle exactly once, count toward the budget meanwhile.
  interface LateEntry {
    sessionId: string;
    finish: (value: unknown) => void;
  }
  const late = new Set<LateEntry>();

  const nowIso = () => now().toISOString();

  // ───────────── snapshots & events ─────────────

  function requireSession(id: string): SessionInfo {
    if (typeof id !== 'string' || id === '') throw new GameError('not_found', 'Session not found');
    const s = repo.getSession(id);
    if (!s) throw new GameError('not_found', `Session ${id} not found`);
    return s;
  }

  function adapterFor(session: SessionInfo): ProviderAdapter | undefined {
    return isAiKind(session.player.kind) ? adapters.get(session.player.kind) : undefined;
  }

  function usageSummaryFor(session: SessionInfo, records: UsageRecord[]): UsageSummary {
    const adapter = adapterFor(session);
    const paid = session.mode === 'ai' && (adapter?.capabilities.paid ?? false);
    let defaultBasis: CostBasis = 'not-applicable';
    if (session.mode === 'ai') {
      if (!paid) defaultBasis = 'local-no-charge';
      else if (adapter?.capabilities.reportsCost) defaultBasis = 'provider-reported';
      else {
        const cfg = resolveProviderConfig(session.player.kind as AiProviderKind, session.player, config);
        defaultBasis = sessionPricing(core, session.player.kind as AiProviderKind, session.player, cfg.model) ? 'estimated-from-pricing' : 'unknown';
      }
    }
    return summarizeUsage(records, { budgetMicros: session.limits.budgetMicros, paid, defaultBasis });
  }

  function buildSnapshot(id: string): SessionSnapshot {
    const session = requireSession(id);
    const currentRound = repo.getLatestRound(id);
    const recentRounds = repo
      .listRounds(id, { limit: RECENT_ROUNDS + 1 })
      .filter((r) => r.status === 'settled')
      .slice(0, RECENT_ROUNDS);
    const lastDecision = repo.listDecisions(id, 1)[0] ?? null;
    const flight = runners.inFlight(id);
    return {
      session,
      currentRound,
      recentRounds,
      lastDecision,
      usage: usageSummaryFor(session, repo.listUsage(id)),
      inFlight: {
        decision: flight.decision,
        round: flight.round || (currentRound !== null && currentRound.status !== 'settled'),
      },
    };
  }

  function emit(sessionId: string, ev: ServerEvent): void {
    hub.emit(sessionId, ev);
  }

  function emitSnapshot(sessionId: string): void {
    if (hub.listenerCount(sessionId) === 0) return; // snapshots are only built for subscribers
    try {
      emit(sessionId, { type: 'snapshot', snapshot: buildSnapshot(sessionId) });
    } catch {
      /* session vanished or repository closed: nothing to publish */
    }
  }

  const roundDeps: RoundFlowDeps = {
    repo,
    outcomeSource,
    nowIso,
    emitRound: (round: RoundRecord) => emit(round.sessionId, { type: 'round', round }),
    emitSnapshot,
  };

  const core: SessionCore = {
    config,
    repo,
    adapters,
    outcomeSource,
    demoPlayer,
    now,
    nowIso,
    sleep,
    presentationDelayMs,
    settings: () => loadSettings(repo),
    roundDeps,
    emit,
    emitSnapshot,
    emitRound: roundDeps.emitRound,

    log(sessionId, level, type, message) {
      try {
        const entry = repo.appendLog(sessionId, level, type, redact(message));
        emit(sessionId, { type: 'log', log: entry });
      } catch {
        /* logging must never break the game flow */
      }
    },

    updateSession(id, patch: SessionPatch) {
      const s = repo.updateSession(id, patch.message ? { ...patch, message: redact(patch.message) } : patch);
      emitSnapshot(id);
      return s;
    },

    insertDecision(rec) {
      const clean = redactDecisionText(rec);
      repo.insertDecision(clean);
      const stored = repo.getDecision(rec.id) ?? clean;
      emit(rec.sessionId, { type: 'decision', decision: stored });
      return stored;
    },

    updateDecision(id, patch) {
      const d = repo.updateDecision(id, redactDecisionText(patch));
      emit(d.sessionId, { type: 'decision', decision: d });
      return d;
    },

    insertUsage(rec) {
      const clean = redactUsageRecord(rec);
      repo.insertUsage(clean);
      emit(clean.sessionId, { type: 'usage', usage: clean });
      return clean;
    },

    trackLate<T>(sessionId: string, promise: Promise<T>, onSettle: (value: T | null) => void) {
      let settled = false;
      const entry: LateEntry = {
        sessionId,
        finish: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          late.delete(entry);
          try {
            onSettle(value as T | null);
          } catch {
            /* repository may already be closed during shutdown */
          }
          emitSnapshot(sessionId);
        },
      };
      const timer = setTimeout(() => entry.finish(null), LATE_GIVE_UP_MS);
      timer.unref?.();
      late.add(entry);
      promise.then(
        (v) => entry.finish(v),
        () => entry.finish(null),
      );
    },

    outstandingAttempts(sessionId) {
      let n = 0;
      for (const e of late) if (e.sessionId === sessionId) n++;
      return n;
    },
  };

  const runners = createRunnerManager(core);

  // ───────────── providers ─────────────

  function resolvedFor(kind: AiProviderKind, player?: PlayerConfig) {
    let base: Partial<PlayerConfig> | undefined;
    if (player !== undefined) {
      const p = validatePlayerConfig(player);
      if (p.kind !== kind) throw new GameError('validation_error', `player.kind must be "${kind}"`);
      base = p;
    } else {
      base = loadSettings(repo).players[kind];
    }
    return resolveProviderConfig(kind, base, config);
  }

  function requireAdapter(kind: unknown): ProviderAdapter {
    if (!isAiKind(kind)) throw new GameError('not_found', `Unknown provider "${String(kind)}"`);
    const adapter = adapters.get(kind);
    if (!adapter) throw new GameError('provider_unavailable', `No adapter is available for provider "${kind}"`);
    return adapter;
  }

  function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort('timeout'), ms);
    return { signal: ctl.signal, done: () => clearTimeout(t) };
  }

  // ───────────── manual play helpers ─────────────

  /** After a manual round: end the session when a limit makes further play impossible. */
  function completeManualIfLimited(sessionId: string): void {
    const s = requireSession(sessionId);
    if (s.status !== 'ready') return;
    const l = s.limits;
    if (l.maxRounds !== null && s.roundsPlayed >= l.maxRounds) {
      core.updateSession(sessionId, { status: 'completed', endReason: 'max_rounds', message: `Completed: reached the limit of ${l.maxRounds} rounds.` });
      core.log(sessionId, 'info', 'session_completed', `Reached the limit of ${l.maxRounds} rounds`);
    } else if (s.balance < l.minStake) {
      core.updateSession(sessionId, {
        status: 'completed',
        endReason: 'insufficient_balance',
        message: `Completed: balance ${formatCredits(s.balance)} is below the minimum stake of ${formatCredits(l.minStake)}.`,
      });
      core.log(sessionId, 'info', 'session_completed', 'Balance is below the minimum stake');
    }
  }

  function defaultName(player: PlayerConfig): string {
    if (player.kind === 'manual') return 'Manual play';
    if (player.kind === 'demo') return DEMO_PLAYER_LABEL;
    const label = adapters.get(player.kind as AiProviderKind)?.capabilities.label ?? player.kind;
    return player.model ? `${label} · ${player.model}` : label;
  }

  // ───────────── GameService ─────────────

  const service: GameService = {
    listProviders(): ProviderStatus[] {
      const settings = loadSettings(repo);
      return AI_PROVIDER_KINDS.map((kind): ProviderStatus => {
        const adapter = adapters.get(kind);
        const defaults = providerDefaults(kind, config);
        if (!adapter) {
          return {
            kind,
            capabilities: missingCapabilities(kind),
            configured: false,
            enabled: false,
            issues: ['Adapter not available in this build'],
            defaults,
            lastTest: lastTests.get(kind) ?? null,
          };
        }
        const cfg = resolveProviderConfig(kind, settings.players[kind], config);
        const gate = serverGate(kind, config);
        let check: { configured: boolean; enabled: boolean; issues: string[] };
        try {
          check = adapter.check(cfg);
        } catch (err) {
          check = { configured: false, enabled: false, issues: [`Configuration check failed: ${err instanceof Error ? err.message : String(err)}`] };
        }
        return {
          kind,
          capabilities: adapter.capabilities,
          configured: check.configured,
          enabled: gate.enabled && check.enabled,
          issues: [...(gate.issue ? [gate.issue] : []), ...check.issues].map(redact),
          defaults,
          lastTest: lastTests.get(kind) ?? null,
        };
      });
    },

    async testProvider(kind, player) {
      const adapter = requireAdapter(kind);
      const cfg = resolvedFor(adapter.kind, player);
      const gate = serverGate(adapter.kind, config);
      let result: ConnectionTestResult;
      if (!gate.enabled) {
        result = { ok: false, testedAt: nowIso(), latencyMs: null, message: gate.issue ?? 'Disabled on the server' };
      } else {
        const t = withTimeout(PROVIDER_META_TIMEOUT_MS);
        try {
          result = await adapter.testConnection(cfg, t.signal);
        } catch (err) {
          result = { ok: false, testedAt: nowIso(), latencyMs: null, message: `Connection test failed: ${err instanceof Error ? err.message : String(err)}` };
        } finally {
          t.done();
        }
      }
      // Provider-supplied text (message, version, the model list the UI offers): masked before it is
      // returned or cached for GET /api/providers (lastTest).
      const clean = redactConnectionTest(result);
      lastTests.set(adapter.kind, clean);
      return clean;
    },

    async listModels(kind, player) {
      const adapter = requireAdapter(kind);
      if (!adapter.listModels) throw new GameError('invalid_state', `${adapter.capabilities.label} does not list models; type the model id`);
      const cfg = resolvedFor(adapter.kind, player);
      const t = withTimeout(PROVIDER_META_TIMEOUT_MS);
      try {
        // Provider-supplied text: masked like every other provider output before it reaches the UI.
        const models = await adapter.listModels(cfg, t.signal);
        return models.map((m) => redact(String(m)));
      } catch (err) {
        if (err instanceof GameError) throw new GameError(err.code, redact(err.message), err.details);
        throw new GameError('provider_unavailable', `Could not list models: ${redact(err instanceof Error ? err.message : String(err))}`);
      } finally {
        t.done();
      }
    },

    getSettings() {
      return loadSettings(repo);
    },

    updateSettings(patch) {
      const saved = saveSettings(repo, patch);
      // A wait between rounds in progress picks up a changed roundPacingMs at once.
      runners.settingsChanged();
      return saved;
    },

    listSessions() {
      return repo.listSessions();
    },

    createSession(req: CreateSessionRequest, idempotencyKey: string) {
      const key = requireKey(idempotencyKey);
      const parsed = validateCreateSessionRequest(req);
      const fingerprint = createSessionFingerprint(parsed);

      // The same key must carry the same request: a replay returns the first session, a different
      // request under that key is a client error (409), never silently answered with the old session.
      const replay = (sessionId: string, storedFingerprint: string | null) => {
        if (storedFingerprint !== null && storedFingerprint !== fingerprint) {
          throw new GameError(
            'duplicate_request',
            'This Idempotency-Key was already used to create a session with a different request; no new session was created',
            { sessionId },
          );
        }
        return buildSnapshot(sessionId);
      };
      // Checked before the limits are merged with the current defaults, so a genuine retry replays
      // even if the defaults changed in between. (Records written before fingerprints existed carry
      // none and are treated as replays.)
      const prior = repo.getIdempotent(CREATE_SESSION_SCOPE, key) as { sessionId?: unknown; fingerprint?: unknown } | null;
      if (prior && typeof prior.sessionId === 'string' && repo.getSession(prior.sessionId)) {
        return replay(prior.sessionId, typeof prior.fingerprint === 'string' ? prior.fingerprint : null);
      }

      const settings = loadSettings(repo);
      const limits = validateLimits({ ...settings.defaultLimits, ...(parsed.limits ?? {}) });
      const player = parsed.player;
      const mode = modeFor(player.kind);
      const id = randomUUID();
      const name = parsed.name && parsed.name.length > 0 ? parsed.name : defaultName(player);

      // Session + idempotency record in ONE transaction: a crash can never leave a session without
      // its record (which would let a retry create a second one).
      const created = repo.createSessionIdempotent(
        { id, name, mode, player, limits, createdAt: nowIso() },
        { scope: CREATE_SESSION_SCOPE, key, fingerprint },
      );
      if (!created.created) return replay(created.session.id, created.fingerprint);
      if (mode === 'ai') rememberPlayer(repo, player);
      core.log(id, 'info', 'session_created', `Session created (${mode}${mode === 'ai' ? `: ${player.kind}${player.model ? ` ${player.model}` : ''}` : ''})`);
      return buildSnapshot(id);
    },

    getSnapshot(sessionId) {
      return buildSnapshot(sessionId);
    },

    placeManualRound(sessionId, bets: BetInput[], idempotencyKey) {
      const key = requireKey(idempotencyKey);
      const session = requireSession(sessionId);

      // Replay: the same key returns the same round — no second charge, no new outcome.
      const existing = repo.findRoundByIdempotencyKey(sessionId, key);
      if (existing) {
        // The same key must carry the same bet slip (order-insensitive, identical positions merged).
        // A different slip is a client error, never silently answered with the old round (reviewer D3).
        const requested = slipSignature(bets);
        if (requested === null || requested !== slipSignature(existing.bets)) {
          throw new GameError(
            'duplicate_request',
            'This Idempotency-Key was already used for a different bet slip; nothing was charged again',
            { roundId: existing.id },
          );
        }
        // A committed-but-unfinished round is still owed its (first) outcome and settlement.
        const round = existing.status === 'settled' ? existing : settleStoredRound(roundDeps, existing);
        return { round, snapshot: buildSnapshot(sessionId) };
      }

      if (session.mode !== 'manual') throw new GameError('invalid_state', 'Bets can only be placed by hand in a manual session');
      if (session.status !== 'ready') {
        throw new GameError('invalid_state', `The session is ${session.status}${session.endReason ? ` (${session.endReason})` : ''}; no more rounds can be played`);
      }

      const resolved = validateBetSlip(bets, { balance: session.balance, limits: session.limits });
      const { round } = playRound(roundDeps, { sessionId, source: 'manual', decisionId: null, bets: resolved, idempotencyKey: key });
      core.log(
        sessionId,
        'info',
        'round_settled',
        `Round ${round.seq}: ${round.winningNumber} — staked ${formatCredits(round.totalStake)}, returned ${formatCredits(round.totalReturned ?? 0)}, ` +
          `net ${formatCredits(round.net ?? 0, { sign: true })}`,
      );
      completeManualIfLimited(sessionId);
      const response: ManualRoundResponse = { round, snapshot: buildSnapshot(sessionId) };
      return response;
    },

    async control(sessionId, action, idempotencyKey) {
      const key = requireKey(idempotencyKey);
      if (!CONTROL_ACTIONS.includes(action)) throw new GameError('validation_error', `Unknown control action "${String(action)}"`);
      const session = requireSession(sessionId);

      const scope = `control:${session.id}`;
      const prior = repo.getIdempotent(scope, key) as { action?: ControlAction } | null;
      if (prior) {
        if (prior.action !== action) {
          throw new GameError('duplicate_request', `Idempotency-Key was already used for "${String(prior.action)}"`);
        }
        return buildSnapshot(sessionId); // replay: no further effect
      }

      switch (action) {
        case 'start':
        case 'step':
          runners.start(sessionId, { step: action === 'step' });
          repo.putIdempotent(scope, key, { action });
          break;
        case 'pause':
          runners.pause(sessionId);
          repo.putIdempotent(scope, key, { action });
          break;
        case 'stop': {
          const wait = runners.stop(sessionId); // synchronous part runs before the key is stored
          repo.putIdempotent(scope, key, { action });
          await wait;
          break;
        }
      }
      return buildSnapshot(sessionId);
    },

    listRounds(sessionId, opts) {
      requireSession(sessionId);
      return repo.listRounds(sessionId, opts);
    },

    listDecisions(sessionId, limit): DecisionRecord[] {
      requireSession(sessionId);
      return repo.listDecisions(sessionId, limit);
    },

    getUsage(sessionId) {
      const session = requireSession(sessionId);
      const records = repo.listUsage(sessionId);
      return { records, summary: usageSummaryFor(session, records) };
    },

    listLogs(sessionId, limit): LogEntry[] {
      requireSession(sessionId);
      return repo.listLogs(sessionId, limit);
    },

    exportSession(sessionId, format) {
      requireSession(sessionId);
      if (format !== 'json' && format !== 'csv') throw new GameError('validation_error', 'format must be json or csv');
      // Final masking pass over every string (stored text is masked already; this also covers rows
      // written by older versions). Done on the data, not the serialised body, so JSON/CSV stay valid.
      // Masking happens field by field in db/export.ts (free-text fields and URL query strings only),
      // so ids, kinds, statuses and timestamps are never altered.
      const data: SessionExport = repo.exportSession(sessionId);
      const date = nowIso().slice(0, 10);
      const safeId = sessionId.replace(/[^A-Za-z0-9-]/g, '');
      return format === 'json'
        ? { filename: `luck-session-${safeId}-${date}.json`, contentType: 'application/json; charset=utf-8', body: toJsonExport(data) }
        : { filename: `luck-session-${safeId}-${date}.csv`, contentType: 'text/csv; charset=utf-8', body: toCsvExport(data) };
    },

    subscribe(sessionId, listener) {
      return hub.subscribe(sessionId, listener);
    },

    recover() {
      let settledRounds = 0;
      let pausedSessions = 0;
      let interruptedDecisions = 0;

      // 1. Finish rounds: committed → first (only) draw; outcome_recorded → settle with the STORED number.
      for (const round of repo.findUnsettledRounds()) {
        const hadOutcome = round.status === 'outcome_recorded';
        let settled: RoundRecord;
        try {
          settled = settleStoredRound(roundDeps, round);
        } catch (err) {
          // One broken round must not block recovery of the others; it stays unsettled and visible.
          core.log(round.sessionId, 'error', 'recovery_failed', `Could not recover round ${round.seq}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (settled.status === 'settled') {
          settledRounds++;
          core.log(
            round.sessionId,
            'warn',
            'recovery_settled',
            `Recovered round ${round.seq}: ${hadOutcome ? 'settled with its stored outcome' : 'outcome drawn after restart and settled'} (${settled.winningNumber})`,
          );
        }
      }

      // 2. Pending decisions → interrupted (+ one unknown-usage record for the attempt in flight).
      for (const d of repo.findPendingDecisions()) {
        repo.updateDecision(d.id, {
          status: 'interrupted',
          completedAt: nowIso(),
          errorCode: 'cancelled',
          errorMessage: 'Server restarted while the request was in flight; no result was received',
        });
        interruptedDecisions++;
        if (d.attempts > 0 && isAiKind(d.providerKind)) {
          const already = repo.listUsage(d.sessionId).some((u) => u.decisionId === d.id && u.attempt === d.attempts);
          if (!already) {
            const paid = adapters.get(d.providerKind)?.capabilities.paid ?? true;
            repo.insertUsage(redactUsageRecord({
              id: randomUUID(),
              sessionId: d.sessionId,
              decisionId: d.id,
              attempt: d.attempts,
              providerKind: d.providerKind,
              model: d.model,
              status: 'error',
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              reasoningTokens: null,
              known: false,
              latencyMs: null,
              generationMs: null,
              outputTokensPerSec: null,
              costMicros: paid ? null : 0,
              costBasis: paid ? 'unknown' : 'local-no-charge',
              rateLimit: null,
              createdAt: nowIso(),
            }));
          }
        }
        core.log(d.sessionId, 'warn', 'recovery_decision', `Decision for round ${d.roundNumber} was interrupted by a restart`);
      }

      // 3. Sessions: never auto-resume (no provider calls, no runners).
      for (const s of repo.listSessions()) {
        if (s.status === 'running' || s.status === 'pause_requested') {
          repo.updateSession(s.id, {
            status: 'paused',
            pauseReason: 'server_restart',
            phase: idlePhase(repo, s.id),
            message: 'The server restarted. Nothing runs automatically — press Start to resume.',
          });
          pausedSessions++;
          core.log(s.id, 'warn', 'recovery_paused', 'Session paused after a server restart');
        } else if (s.status === 'stop_requested') {
          repo.updateSession(s.id, {
            status: 'stopped',
            endReason: 'user_stop',
            pauseReason: null,
            phase: idlePhase(repo, s.id),
            message: 'Stopped by user (completed after a server restart).',
          });
          core.log(s.id, 'info', 'recovery_stopped', 'Pending stop completed after a server restart');
        } else if (s.phase === 'requesting_decision') {
          repo.updateSession(s.id, { phase: idlePhase(repo, s.id) });
        }
      }

      return { settledRounds, pausedSessions, interruptedDecisions };
    },

    async shutdown() {
      await runners.shutdown(SHUTDOWN_WAIT_MS);
      // Late attempts that never answered: record them as unknown usage now.
      for (const entry of [...late]) entry.finish(null);
    },
  };

  return service;
}
