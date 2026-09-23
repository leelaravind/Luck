/**
 * One decision per round: the demo player (synchronous rule) or an AI provider with bounded
 * retries, per-attempt budget pre-checks, usage recording and stale/cancel protection.
 *
 * Invariants:
 *  - the model only receives the GameObservation (via the prompts built from it)
 *  - an invalid decision is NEVER converted into a different bet and a failing AI provider NEVER
 *    falls back to the demo player; the caller pauses the session instead
 *  - every attempt that reaches the adapter gets exactly one UsageRecord (late results included)
 *  - a result that arrives after Stop / an epoch change is discarded ('stale') but still recorded
 */
import { randomUUID } from 'node:crypto';
import {
  GameError,
  MAX_EXPLANATION_CHARS,
  MAX_RAW_OUTPUT_CHARS,
  type AiProviderKind,
  type DecisionRecord,
  type PauseReason,
  type PlayerDecision,
  type Pricing,
  type ProviderError,
  type ResolvedBet,
  type SessionInfo,
  type UsageAttemptStatus,
} from '../../shared/contracts.js';
import { validateBetSlip } from '../../shared/bets.js';
import { decisionJsonSchema, parseDecision } from '../../shared/decision.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import { redact } from '../redact.js';
import { resolveProviderConfig } from '../providers/registry.js';
import { checkBudget } from './budget.js';
import type { SessionCore } from './core.js';
import { buildObservation } from './observation.js';
import { buildCorrectiveNote, buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { computeBackoffMs, waitAbortable } from './retry.js';
import { pricingKey } from './settings.js';
import { buildUsageRecord, UNKNOWN_USAGE, usageStatusFor } from './usage.js';

/** Extra time past req.timeoutMs before the runner stops waiting for a misbehaving adapter. */
export const WATCHDOG_GRACE_MS = 5_000;
/** How long a late (abandoned) attempt may take before it is recorded as unknown usage. */
export const LATE_GIVE_UP_MS = 120_000;

/** Why the runner's signal was aborted. */
export type AbortReason = 'stop' | 'shutdown';

export type DecisionOutcome =
  | { kind: 'bet'; decisionId: string; bets: ResolvedBet[]; explanation: string | null }
  | { kind: 'skip'; decisionId: string; explanation: string | null }
  | { kind: 'stop'; decisionId: string; explanation: string | null }
  | { kind: 'blocked_budget'; decisionId: string; message: string }
  | { kind: 'failed'; decisionId: string; pauseReason: Extract<PauseReason, 'provider_error' | 'rate_limited' | 'invalid_output'>; message: string }
  | { kind: 'aborted'; decisionId: string | null; reason: AbortReason | 'stale' };

/** The rows history needed for an observation: the last `historyWindow` rounds (+1 for a pending one). */
export function observationRounds(core: SessionCore, session: SessionInfo) {
  return core.repo.listRounds(session.id, { limit: Math.max(1, session.limits.historyWindow + 1) });
}

/** Pricing assumption for a player: explicit on the player, else settings (defaults merged with user entries). */
export function resolvePricing(core: SessionCore, kind: AiProviderKind, player: SessionInfo['player'], model: string | undefined): Pricing | null {
  if (player.pricing) return player.pricing;
  return core.settings().pricing[pricingKey(kind, model)] ?? null;
}

function newDecision(core: SessionCore, session: SessionInfo, roundNumber: number, model: string | null): DecisionRecord {
  return {
    id: randomUUID(),
    sessionId: session.id,
    roundNumber,
    epoch: session.epoch,
    providerKind: session.player.kind,
    model,
    status: 'pending',
    action: null,
    bets: null,
    explanation: null,
    rawOutput: null,
    validationErrors: [],
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    startedAt: core.nowIso(),
    completedAt: null,
    latencyMs: null,
  };
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function rawOutputOf(result: ProviderCallResult): string | null {
  if (result.text !== null && result.text !== undefined) return clip(redact(result.text), MAX_RAW_OUTPUT_CHARS);
  if (result.structured !== undefined) {
    try {
      return clip(redact(JSON.stringify(result.structured)), MAX_RAW_OUTPUT_CHARS);
    } catch {
      return null;
    }
  }
  return null;
}

function gameErrorMessages(err: unknown): string[] {
  if (err instanceof GameError) return [err.message];
  return [err instanceof Error ? err.message : String(err)];
}

// ───────────────────────────── demo player ─────────────────────────────

export function demoDecision(core: SessionCore, session: SessionInfo): DecisionOutcome {
  const obs = buildObservation(session, observationRounds(core, session));
  const d = core.demoPlayer.decide(obs);
  const rec = newDecision(core, session, obs.roundNumber, null);
  rec.attempts = 1;
  rec.action = d.action;
  rec.explanation = clip(d.explanation, MAX_EXPLANATION_CHARS);
  rec.completedAt = rec.startedAt;
  rec.latencyMs = 0;

  if (d.action === 'bet') {
    rec.bets = d.bets ?? [];
    try {
      const bets = validateBetSlip(d.bets ?? [], { balance: session.balance, limits: session.limits });
      core.insertDecision({ ...rec, status: 'accepted' });
      return { kind: 'bet', decisionId: rec.id, bets, explanation: rec.explanation };
    } catch (err) {
      // Only possible with limits the demo rule cannot satisfy. Never "repaired" into another bet.
      const errors = gameErrorMessages(err);
      core.insertDecision({ ...rec, status: 'invalid', validationErrors: errors, errorCode: 'invalid_output', errorMessage: errors[0] ?? null });
      return {
        kind: 'failed',
        decisionId: rec.id,
        pauseReason: 'invalid_output',
        message: `The demo player's bet was rejected by the table rules: ${errors.join('; ')}`,
      };
    }
  }
  core.insertDecision({ ...rec, status: 'accepted' });
  return d.action === 'skip'
    ? { kind: 'skip', decisionId: rec.id, explanation: rec.explanation }
    : { kind: 'stop', decisionId: rec.id, explanation: rec.explanation };
}

// ───────────────────────────── AI provider ─────────────────────────────

type CallOutcome =
  | { kind: 'result'; result: ProviderCallResult }
  | { kind: 'abandoned'; reason: AbortReason | 'watchdog'; late: Promise<ProviderCallResult> };

function syntheticFailure(code: ProviderError['code'], message: string, retryable: boolean): ProviderCallResult {
  return {
    ok: false,
    text: null,
    usage: { ...UNKNOWN_USAGE },
    latencyMs: 0,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: null,
    rateLimit: null,
    error: { code, message, retryable },
  };
}

/** Call the adapter once. Resolves early (abandoning the call) on Stop/shutdown or the watchdog. */
async function callAdapter(
  adapter: ProviderAdapter,
  req: DecisionRequest,
  cfg: ResolvedProviderConfig,
  runSignal: AbortSignal,
): Promise<CallOutcome> {
  const attempt = new AbortController();
  const onRunAbort = () => attempt.abort(runSignal.reason);
  if (runSignal.aborted) attempt.abort(runSignal.reason);
  else runSignal.addEventListener('abort', onRunAbort, { once: true });
  const watchdog = setTimeout(() => attempt.abort('watchdog'), req.timeoutMs + WATCHDOG_GRACE_MS);

  let promise: Promise<ProviderCallResult>;
  try {
    promise = Promise.resolve(adapter.decide(req, cfg, attempt.signal));
  } catch (err) {
    promise = Promise.resolve(syntheticFailure('unknown', `Adapter threw: ${err instanceof Error ? err.message : String(err)}`, false));
  }
  // Adapters must not throw, but a rejected promise must never escape as an unhandled rejection.
  promise = promise.catch((err: unknown) =>
    syntheticFailure('unknown', `Adapter threw: ${err instanceof Error ? err.message : String(err)}`, false),
  );

  try {
    const aborted = new Promise<'aborted'>((resolve) => {
      if (attempt.signal.aborted) resolve('aborted');
      else attempt.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const first = await Promise.race([promise.then((r) => ({ r })), aborted]);
    if (first !== 'aborted') return { kind: 'result', result: first.r };
    const reason = attempt.signal.reason === 'watchdog' ? 'watchdog' : attempt.signal.reason === 'shutdown' ? 'shutdown' : 'stop';
    return { kind: 'abandoned', reason, late: promise };
  } finally {
    clearTimeout(watchdog);
    runSignal.removeEventListener('abort', onRunAbort);
  }
}

type Failure = { type: 'provider'; error: ProviderError } | { type: 'invalid'; errors: string[] };

/**
 * Request ONE decision for the upcoming round. `runSignal` is aborted by Stop (reason 'stop') or
 * server shutdown (reason 'shutdown').
 */
export async function requestAiDecision(
  core: SessionCore,
  session: SessionInfo,
  runSignal: AbortSignal,
): Promise<DecisionOutcome> {
  const kind = session.player.kind as AiProviderKind;
  const adapter = core.adapters.get(kind);
  const limits = session.limits;
  const cfg = resolveProviderConfig(kind, session.player, core.config);
  const model = cfg.model ?? null;
  const obs = buildObservation(session, observationRounds(core, session));
  const decision = core.insertDecision(newDecision(core, session, obs.roundNumber, model));
  const startedAtMs = core.now().getTime();
  const elapsed = () => Math.max(0, core.now().getTime() - startedAtMs);

  const finish = (patch: Partial<DecisionRecord>) =>
    core.updateDecision(decision.id, { completedAt: core.nowIso(), latencyMs: elapsed(), ...patch });

  if (!adapter) {
    const message = `No adapter is available for provider "${kind}".`;
    finish({ status: 'failed', errorCode: 'not_configured', errorMessage: message });
    return { kind: 'failed', decisionId: decision.id, pauseReason: 'provider_error', message };
  }

  const caps = adapter.capabilities;
  const pricing = resolvePricing(core, kind, session.player, cfg.model);
  const systemPrompt = buildSystemPrompt(obs, { allowStop: session.limits.allowModelStop === true });
  const maxAttempts = 1 + Math.max(0, limits.maxRetries);
  const label = caps.label || kind;
  let correctiveNote: string | null = null;
  let lastFailure: Failure | null = null;
  let lastRaw: string | null = null;

  const cancelled = (reason: AbortReason): DecisionOutcome => {
    finish({
      status: reason === 'shutdown' ? 'interrupted' : 'cancelled',
      errorCode: 'cancelled',
      errorMessage: reason === 'shutdown' ? 'Server shut down while the request was in flight' : 'Cancelled by Stop',
    });
    return { kind: 'aborted', decisionId: decision.id, reason };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (runSignal.aborted) return cancelled(runSignal.reason === 'shutdown' ? 'shutdown' : 'stop');

    const userPrompt = buildUserPrompt(obs, correctiveNote);

    // Budget pre-check before EVERY attempt of a paid provider.
    let maxBudgetUsd: number | null = null;
    if (caps.paid) {
      const check = checkBudget({
        capabilities: caps,
        pricing,
        budgetMicros: limits.budgetMicros,
        promptChars: systemPrompt.length + userPrompt.length,
        maxOutputTokens: limits.maxOutputTokens,
        records: core.repo.listUsage(session.id),
        outstandingAttempts: core.outstandingAttempts(session.id),
      });
      if (!check.allowed) {
        finish({ status: 'blocked_budget', errorCode: 'budget', errorMessage: check.message, attempts: attempt - 1 });
        return { kind: 'blocked_budget', decisionId: decision.id, message: check.message };
      }
      // No app limit → no --max-budget-usd cap is passed to the CLI either.
      maxBudgetUsd = check.remainingMicros === null ? null : check.remainingMicros / 1_000_000;
    }

    core.updateDecision(decision.id, { attempts: attempt });
    const req: DecisionRequest = {
      observation: obs,
      systemPrompt,
      userPrompt,
      jsonSchema: decisionJsonSchema({ allowStop: limits.allowModelStop === true }),
      model: cfg.model,
      maxOutputTokens: limits.maxOutputTokens,
      timeoutMs: limits.decisionTimeoutMs,
      maxBudgetUsd,
      conversationKey: session.id,
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    };

    const record = (result: ProviderCallResult | null, status: UsageAttemptStatus) =>
      core.insertUsage(
        buildUsageRecord({
          sessionId: session.id,
          decisionId: decision.id,
          attempt,
          providerKind: kind,
          model,
          status,
          result,
          capabilities: caps,
          pricing,
          createdAt: core.nowIso(),
        }),
      );

    const call = await callAdapter(adapter, req, cfg, runSignal);

    if (call.kind === 'abandoned') {
      const reason = call.reason;
      // The attempt's usage is recorded when (if) the late result arrives.
      core.trackLate(session.id, call.late, (late) => {
        if (reason === 'watchdog') {
          record(late, 'timeout');
          return;
        }
        if (late && late.ok) {
          record(late, 'stale');
          // The model did answer, but after Stop: keep it for inspection, never apply it.
          if (reason === 'stop') {
            try {
              core.updateDecision(decision.id, { status: 'stale', rawOutput: rawOutputOf(late) });
            } catch {
              /* repository may be closed during shutdown */
            }
          }
        } else {
          record(late, late ? (usageStatusFor(late) === 'cancelled' ? 'cancelled' : usageStatusFor(late)) : 'cancelled');
        }
      });
      if (reason === 'watchdog') {
        lastFailure = {
          type: 'provider',
          error: { code: 'timeout', message: `No response within ${limits.decisionTimeoutMs} ms`, retryable: true },
        };
      } else {
        return cancelled(reason);
      }
    } else {
      const result = call.result;

      // Stale protection: Stop/epoch change while the request was in flight → discard.
      const now = core.repo.getSession(session.id);
      if (!now || now.epoch !== session.epoch || now.status === 'stop_requested' || now.status === 'stopped') {
        record(result, 'stale');
        finish({ status: 'stale', rawOutput: rawOutputOf(result), errorMessage: 'Response arrived after Stop; discarded' });
        return { kind: 'aborted', decisionId: decision.id, reason: 'stale' };
      }

      if (!result.ok) {
        const error: ProviderError = result.error ?? { code: 'unknown', message: 'Provider returned no result', retryable: false };
        if (error.code === 'invalid_output') {
          record(result, 'invalid_output');
          lastRaw = rawOutputOf(result) ?? lastRaw;
          lastFailure = { type: 'invalid', errors: [redact(error.message)] };
          correctiveNote = buildCorrectiveNote(lastFailure.errors);
          core.updateDecision(decision.id, { validationErrors: lastFailure.errors, rawOutput: lastRaw });
          continue;
        }
        record(result, usageStatusFor(result));
        lastFailure = { type: 'provider', error: { ...error, message: redact(error.message) } };
        if (error.code === 'budget') {
          const message = `${label} refused the request because the budget limit was reached: ${redact(error.message)}`;
          finish({ status: 'blocked_budget', errorCode: 'budget', errorMessage: message });
          return { kind: 'blocked_budget', decisionId: decision.id, message };
        }
        if (!error.retryable) break;
      } else {
        // Parse (shape) then validate against the table rules + current balance.
        lastRaw = rawOutputOf(result);
        const parsed = parseDecision({ text: result.text, structured: result.structured });
        let errors: string[] = [];
        let resolved: ResolvedBet[] = [];
        let decided: PlayerDecision | null = null;
        if (!parsed.ok) {
          errors = parsed.errors;
        } else {
          decided = parsed.decision;
          if (decided.action === 'stop' && limits.allowModelStop !== true) {
            // Not converted into another action: recorded as invalid and retried / paused like any invalid output.
            errors = ['action "stop" is not available in this session: choose "bet" or "skip" (the user or the limits end the session)'];
          } else if (decided.action === 'bet') {
            try {
              resolved = validateBetSlip(decided.bets, { balance: session.balance, limits });
            } catch (err) {
              errors = gameErrorMessages(err);
            }
          }
        }

        if (errors.length > 0 || !decided) {
          record(result, 'invalid_output');
          lastFailure = { type: 'invalid', errors: errors.map(redact) };
          correctiveNote = buildCorrectiveNote(lastFailure.errors);
          core.updateDecision(decision.id, { validationErrors: lastFailure.errors, rawOutput: lastRaw });
          continue;
        }

        record(result, 'ok');
        // The stated strategy is kept with the explanation so every view (card, log, export) shows it.
        // Stored as "Strategy: <name>" on its own first line, then the explanation (the UI splits them).
        const strategyLine = decided.strategy ? `Strategy: ${decided.strategy.replace(/\s+/g, ' ')}` : '';
        const stated = [strategyLine, decided.explanation ?? ''].filter(Boolean).join('\n');
        const explanation = clip(stated === '' ? null : stated, MAX_EXPLANATION_CHARS);
        finish({
          status: 'accepted',
          action: decided.action,
          bets: decided.action === 'bet' ? decided.bets : null,
          explanation,
          rawOutput: lastRaw,
          validationErrors: [],
          errorCode: null,
          errorMessage: null,
        });
        if (decided.action === 'bet') return { kind: 'bet', decisionId: decision.id, bets: resolved, explanation };
        if (decided.action === 'skip') return { kind: 'skip', decisionId: decision.id, explanation };
        return { kind: 'stop', decisionId: decision.id, explanation };
      }
    }

    // Retryable provider failure: back off before the next attempt (abortable by Stop).
    if (attempt < maxAttempts && lastFailure?.type === 'provider') {
      const delay = computeBackoffMs(attempt, lastFailure.error);
      core.log(session.id, 'warn', 'provider_retry', `${label} attempt ${attempt} failed (${lastFailure.error.code}); retrying in ${delay} ms`);
      const aborted = await waitAbortable(core.sleep, delay, runSignal);
      if (aborted) return cancelled(runSignal.reason === 'shutdown' ? 'shutdown' : 'stop');
    }
  }

  // Retries exhausted (or a non-retryable error).
  const attempts = core.repo.getDecision(decision.id)?.attempts ?? maxAttempts;
  if (!lastFailure || lastFailure.type === 'invalid') {
    const errors = lastFailure?.errors ?? ['no valid decision'];
    const message =
      `${label} returned invalid output ${attempts} time${attempts === 1 ? '' : 's'}; no bet was placed. ` +
      `Last problem: ${errors[0] ?? 'unknown'}. Session paused — press Start to try again.`;
    finish({ status: 'invalid', validationErrors: errors, errorCode: 'invalid_output', errorMessage: message, rawOutput: lastRaw });
    return { kind: 'failed', decisionId: decision.id, pauseReason: 'invalid_output', message };
  }
  const err = lastFailure.error;
  const message =
    `${label} request failed after ${attempts} attempt${attempts === 1 ? '' : 's'} (${err.code}${err.httpStatus ? ` ${err.httpStatus}` : ''}): ` +
    `${err.message}. No bet was placed. Session paused — press Start to try again.`;
  finish({ status: 'failed', errorCode: err.code, errorMessage: message });
  return {
    kind: 'failed',
    decisionId: decision.id,
    pauseReason: err.code === 'rate_limited' ? 'rate_limited' : 'provider_error',
    message,
  };
}
