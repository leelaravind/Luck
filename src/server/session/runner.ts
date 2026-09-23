/**
 * Autonomous runner (mode 'demo' | 'ai'): at most ONE runner and ONE in-flight decision per session.
 *
 * Status machine (see SessionStatus in contracts):
 *   ready ──start──▶ running ──pause──▶ pause_requested ──(round finishes)──▶ paused ──start──▶ running
 *   ready/paused ──step──▶ running (one round) ──▶ paused (step_complete)
 *   any non-terminal ──stop──▶ stop_requested ──▶ stopped (terminal, user_stop)
 *   running ──limit──▶ completed (terminal: max_rounds / max_runtime / insufficient_balance /
 *                                  budget_exhausted / model_stop)
 *
 * One loop iteration:
 *   honour stop / pause_requested / step and check limits (BEFORE any request) → phase
 *   requesting_decision → exactly one decision → bet/skip: synchronous round flow (commit → draw →
 *   settle) → honour stop / pause_requested / step / limits AT ONCE (a session that reached a limit
 *   completes instead of pausing) → only when another decision follows: round pacing wait.
 * The wait between rounds is settings.roundPacingMs (default 7 s). It does NOT depend on the
 * animation speed, which is presentation only: the animation can never make models be called more
 * often. There is always exactly one decision per round. The wait never delays a control: Pause,
 * Step and Stop end it immediately, and a changed roundPacingMs applies to the wait in progress.
 *
 * Failed decisions: with maxConsecutiveFailures > 1 the runner keeps going after a failed decision,
 * but first waits the provider's Retry-After (or a bounded backoff). Stop, Pause and a reached
 * limit are honoured before that wait, and Stop / Pause end it early ("Paused before the next
 * decision." — no round was played). Only the failure that reaches the limit pauses the session
 * with the failure, and only that one says so.
 *
 * Stop: aborts an in-flight request (decision 'cancelled'; a late answer is recorded as stale and
 * never applied) or the presentation wait. A round whose bets were committed always settles
 * first (the round flow is synchronous), and no further round starts.
 */
import { GameError, type PauseReason, type SessionEndReason, type SessionInfo } from '../../shared/contracts.js';
import { formatCredits } from '../../shared/money.js';
import { redact } from '../redact.js';
import { resolveProviderConfig, serverGate } from '../providers/registry.js';
import { requestAiDecision, demoDecision, sessionPricing, type DecisionOutcome } from './aiDecision.js';
import { idlePhase, type SessionCore } from './core.js';
import { playRound, settleStoredRound } from './roundFlow.js';
import { computeBackoffMs, waitAbortable, yieldToEventLoop } from './retry.js';

/** Kinds whose adapters need an explicit model to run. */
const MODEL_REQUIRED = new Set(['ollama', 'anthropic', 'openai']);
/** How long control('stop') waits for the runner to wind down before returning. */
const STOP_WAIT_MS = 10_000;
/** Appended to the message of a failed decision when (and only when) the session really pauses. */
export const PAUSED_AFTER_FAILURE = 'Session paused — press Start to try again.';
/** Session message of a user pause honoured right after a played round. */
export const PAUSED_AFTER_ROUND = 'Paused after the round, as requested.';
/** Session message of a user pause honoured when no round was played (e.g. after a failed decision). */
export const PAUSED_BEFORE_DECISION = 'Paused before the next decision.';

/** What the runner's previous loop iteration did: decides the pause message and when a Step is done. */
type LastIteration = 'none' | 'round' | 'failed';

interface RunnerHandle {
  readonly sessionId: string;
  readonly controller: AbortController;
  stepOnce: boolean;
  decisionInFlight: boolean;
  roundInFlight: boolean;
  /** Decisions in a row that failed after their bounded retries (reset by any usable decision). */
  consecutiveFailures: number;
  /** 'round' once a round was played, 'failed' after a failed decision, 'none' before either. */
  last: LastIteration;
  /**
   * Ends the current wait between decisions (round pacing / failed-decision backoff) so the runner
   * re-evaluates at once. Signalled by Pause, Step and a settings change; Stop / shutdown abort
   * `controller`, which is forwarded to it. Null while the runner is not waiting.
   */
  wake: AbortController | null;
  lastTick: number;
  done: Promise<void>;
}

export interface RunnerManager {
  start(sessionId: string, opts: { step: boolean }): void;
  pause(sessionId: string): void;
  /** Synchronous part of Stop; the returned promise resolves once the runner has wound down. */
  stop(sessionId: string): Promise<void>;
  /** Settings were saved: a wait in progress re-reads roundPacingMs. */
  settingsChanged(): void;
  inFlight(sessionId: string): { decision: boolean; round: boolean };
  isRunning(sessionId: string): boolean;
  /** Abort every runner (reason 'shutdown') and wait up to `waitMs` for them to exit. */
  shutdown(waitMs: number): Promise<void>;
  /** Test/diagnostic: number of live runners. */
  size(): number;
}

/** How the runner ends at a boundary (see boundaryEnd). */
type BoundaryEnd =
  | { kind: 'stopped' }
  | { kind: 'paused'; reason: PauseReason; message: string }
  | { kind: 'completed'; reason: SessionEndReason; message: string }
  /** The status was changed elsewhere: just let go of the session. */
  | { kind: 'detached' };

export function createRunnerManager(core: SessionCore): RunnerManager {
  const runners = new Map<string, RunnerHandle>();
  let shuttingDown = false;

  function requireSession(id: string): SessionInfo {
    const s = core.repo.getSession(id);
    if (!s) throw new GameError('not_found', `Session ${id} not found`);
    return s;
  }

  // ───────────── preflight: refuse to start what cannot run safely ─────────────

  function preflight(s: SessionInfo): void {
    if (s.mode === 'demo') return;
    const kind = s.player.kind;
    if (kind === 'manual' || kind === 'demo') throw new GameError('invalid_state', `Session mode ${s.mode} does not match player ${kind}`);
    const adapter = core.adapters.get(kind);
    if (!adapter) throw new GameError('provider_unavailable', `No adapter is available for provider "${kind}"`);

    const cfg = resolveProviderConfig(kind, s.player, core.config);
    const gate = serverGate(kind, core.config);
    const check = adapter.check(cfg);
    const issues = [...(gate.issue ? [gate.issue] : []), ...check.issues].map(redact);
    if (!gate.enabled || !check.configured || !check.enabled) {
      throw new GameError('provider_unavailable', `${adapter.capabilities.label} is not ready: ${issues.join('; ') || 'not configured'}`, { issues });
    }
    if (MODEL_REQUIRED.has(kind) && !cfg.model) {
      throw new GameError('invalid_state', `Choose a model for ${adapter.capabilities.label} before starting.`);
    }

    // With no app spending limit (budgetMicros null — the user's explicit choice) nothing needs to be
    // bounded, so a paid provider may start without a pricing assumption.
    if (adapter.capabilities.paid && s.limits.budgetMicros !== null) {
      const pricing = sessionPricing(core, kind, s.player, cfg.model);
      if (!pricing && !adapter.capabilities.reportsCost) {
        throw new GameError(
          'invalid_state',
          `No pricing assumption for ${kind}:${cfg.model ?? '(no model)'} and the provider does not report cost, so the ` +
            'worst-case cost of a request cannot be bounded. Add a pricing entry in Settings (per-MTok input/output USD) first.',
        );
      }
    }
  }

  // ───────────── terminal transitions (synchronous: update + deregister + emit) ─────────────

  function flushRuntime(h: RunnerHandle): SessionInfo {
    const t = core.now().getTime();
    const delta = Math.max(0, t - h.lastTick);
    h.lastTick = t;
    const s = requireSession(h.sessionId);
    if (delta === 0) return s;
    return core.repo.updateSession(h.sessionId, { runtimeMs: s.runtimeMs + delta });
  }

  function deregister(h: RunnerHandle): void {
    if (runners.get(h.sessionId) === h) runners.delete(h.sessionId);
  }

  function finishStopped(h: RunnerHandle): void {
    flushRuntime(h);
    deregister(h);
    core.updateSession(h.sessionId, {
      status: 'stopped',
      endReason: 'user_stop',
      pauseReason: null,
      phase: idlePhase(core.repo, h.sessionId),
      message: 'Stopped by user.',
    });
    core.log(h.sessionId, 'info', 'session_stopped', 'Session stopped by user');
  }

  function finishPaused(h: RunnerHandle, reason: PauseReason | null, message: string): void {
    flushRuntime(h);
    deregister(h);
    core.updateSession(h.sessionId, { status: 'paused', pauseReason: reason, phase: idlePhase(core.repo, h.sessionId), message });
    core.log(h.sessionId, reason === 'user_pause' || reason === 'step_complete' ? 'info' : 'warn', 'session_paused', message);
  }

  function finishCompleted(h: RunnerHandle, reason: SessionEndReason, message: string): void {
    flushRuntime(h);
    deregister(h);
    core.updateSession(h.sessionId, {
      status: 'completed',
      endReason: reason,
      pauseReason: null,
      phase: idlePhase(core.repo, h.sessionId),
      message,
    });
    core.log(h.sessionId, 'info', 'session_completed', message);
  }

  /**
   * What must happen before another decision may be requested, or null to go on:
   *  - Stop → stopped; shutdown → paused (server_restart)
   *  - Pause after round, or the single round of a Step played → paused; but a session that cannot
   *    continue (a reached limit) completes instead of showing "paused"
   *  - status changed elsewhere → detached
   *  - a reached limit → completed
   * Evaluated right after every round and failed decision (so nothing waits for the round pacing
   * or a backoff first) and again before every request.
   */
  function boundaryEnd(h: RunnerHandle, s: SessionInfo): BoundaryEnd | null {
    if (s.status === 'stop_requested') return { kind: 'stopped' };
    if (h.controller.signal.aborted && h.controller.signal.reason === 'shutdown') {
      return { kind: 'paused', reason: 'server_restart', message: 'Server shut down during the session. Press Start to resume.' };
    }
    const stepDone = s.status === 'running' && h.stepOnce && h.last === 'round';
    if (s.status === 'pause_requested' || stepDone) {
      const limit = limitReached(s);
      if (limit) return { kind: 'completed', ...limit };
      if (s.status === 'pause_requested') {
        return { kind: 'paused', reason: 'user_pause', message: h.last === 'round' ? PAUSED_AFTER_ROUND : PAUSED_BEFORE_DECISION };
      }
      return { kind: 'paused', reason: 'step_complete', message: 'Step complete: one round was played.' };
    }
    if (s.status !== 'running') return { kind: 'detached' };
    const limit = limitReached(s);
    return limit ? { kind: 'completed', ...limit } : null;
  }

  function endAt(h: RunnerHandle, end: BoundaryEnd): void {
    switch (end.kind) {
      case 'stopped':
        return finishStopped(h);
      case 'paused':
        return finishPaused(h, end.reason, end.message);
      case 'completed':
        return finishCompleted(h, end.reason, end.message);
      case 'detached':
        return deregister(h);
    }
  }

  /** Honour a pending control request or a reached limit (see boundaryEnd). Returns true when the loop must exit. */
  function atBoundary(h: RunnerHandle, s: SessionInfo): boolean {
    const end = boundaryEnd(h, s);
    if (!end) return false;
    endAt(h, end);
    return true;
  }

  /**
   * Wait between decisions (round pacing or failed-decision backoff) without ever holding up a
   * control. Ends at once on Stop / shutdown (the run signal is forwarded) and as soon as the
   * session is no longer plainly running (Pause requested) or a Step is armed; the caller then
   * re-checks the boundary. A settings change wakes it too and `durationMs` is read again, so a
   * new roundPacingMs applies to the wait in progress (measured from its start). A wake that
   * changed nothing (e.g. a Pause withdrawn by Start) keeps waiting for the remaining time. The wait
   * never runs past the session's runtime limit.
   */
  async function waitBetweenDecisions(h: RunnerHandle, durationMs: () => number): Promise<void> {
    const started = core.now().getTime();
    for (;;) {
      if (h.controller.signal.aborted) return;
      const s = core.repo.getSession(h.sessionId);
      if (!s || s.status !== 'running' || (h.stepOnce && h.last === 'none')) return;
      const now = core.now().getTime();
      let remaining = started + Math.max(0, durationMs()) - now;
      // Runtime keeps counting while waiting: a runtime limit ends the wait when it is reached.
      if (s.limits.maxRuntimeSec !== null) {
        remaining = Math.min(remaining, s.limits.maxRuntimeSec * 1000 - (s.runtimeMs + Math.max(0, now - h.lastTick)));
      }
      if (remaining <= 0) return;
      const wake = new AbortController();
      const forward = () => wake.abort(h.controller.signal.reason);
      h.controller.signal.addEventListener('abort', forward, { once: true });
      h.wake = wake;
      try {
        await waitAbortable(core.sleep, remaining, wake.signal);
      } finally {
        h.controller.signal.removeEventListener('abort', forward);
        if (h.wake === wake) h.wake = null;
      }
      if (!wake.signal.aborted) return; // the full time elapsed
    }
  }

  function limitReached(s: SessionInfo): { reason: SessionEndReason; message: string } | null {
    const l = s.limits;
    if (l.maxRounds !== null && s.roundsPlayed >= l.maxRounds) {
      return { reason: 'max_rounds', message: `Completed: reached the limit of ${l.maxRounds} rounds.` };
    }
    if (l.maxRuntimeSec !== null && s.runtimeMs >= l.maxRuntimeSec * 1000) {
      return { reason: 'max_runtime', message: `Completed: reached the runtime limit of ${l.maxRuntimeSec} s.` };
    }
    if (s.balance < l.minStake) {
      return {
        reason: 'insufficient_balance',
        message: `Completed: balance ${formatCredits(s.balance)} is below the minimum stake of ${formatCredits(l.minStake)}.`,
      };
    }
    return null;
  }

  // ───────────── the loop ─────────────

  async function loop(h: RunnerHandle): Promise<void> {
    const id = h.sessionId;
    try {
      for (;;) {
        await yieldToEventLoop();
        let s = flushRuntime(h);
        // Stop / Pause / Step / a reached limit are honoured BEFORE any request.
        if (atBoundary(h, s)) return;

        core.updateSession(id, { phase: 'requesting_decision' });

        let outcome: DecisionOutcome;
        if (h.decisionInFlight) throw new Error('invariant violated: a decision is already in flight for this session');
        h.decisionInFlight = true;
        try {
          outcome = s.mode === 'demo' ? demoDecision(core, s) : await requestAiDecision(core, s, h.controller.signal);
        } finally {
          h.decisionInFlight = false;
        }

        s = flushRuntime(h);
        if (outcome.kind === 'aborted' || s.status === 'stop_requested') {
          if (outcome.kind === 'aborted' && outcome.reason === 'shutdown') {
            return finishPaused(h, 'server_restart', 'Server shut down during a model request. Press Start to resume.');
          }
          if (s.status === 'stop_requested') return finishStopped(h);
          // Stale result without a stop request (epoch changed elsewhere): re-check at the top.
          h.last = 'none';
          core.updateSession(id, { phase: idlePhase(core.repo, id) });
          continue;
        }

        switch (outcome.kind) {
          case 'blocked_budget':
            return finishCompleted(h, 'budget_exhausted', outcome.message);
          case 'runtime_limit':
            core.log(id, 'warn', 'decision_failed', outcome.message);
            return finishCompleted(h, 'max_runtime', `Completed: reached the runtime limit of ${s.limits.maxRuntimeSec} s.`);
          case 'failed': {
            // Each failed decision already used its bounded retries. Pause once the configured number
            // of consecutive failed decisions is reached (default 1 = pause after the first one).
            h.consecutiveFailures += 1;
            const allowed = Math.max(1, s.limits.maxConsecutiveFailures);
            if (h.consecutiveFailures >= allowed) return finishPaused(h, outcome.pauseReason, `${outcome.message} ${PAUSED_AFTER_FAILURE}`);
            h.last = 'failed';
            s = core.updateSession(id, { phase: idlePhase(core.repo, id) });
            const failed = `${outcome.message} (failed decision ${h.consecutiveFailures} of ${allowed} allowed in a row; no round was played).`;
            // Stop / Pause / a reached limit first: they never wait for the backoff.
            const end = boundaryEnd(h, s);
            if (end) {
              core.log(id, 'warn', 'decision_failed', failed);
              return endAt(h, end);
            }
            // Keep going, but not straight away: honour the provider's Retry-After (capped), else back
            // off 1 s, 2 s, 4 s… Stop / shutdown / Pause end the wait early (handled at the loop top).
            const delay = computeBackoffMs(h.consecutiveFailures, outcome.retryAfterMs !== null ? { retryAfterMs: outcome.retryAfterMs } : null);
            core.log(id, 'warn', 'decision_failed', `${failed} The session keeps running; next decision in ${formatWait(delay)}.`);
            await waitBetweenDecisions(h, () => delay);
            continue;
          }
          case 'stop':
            return finishCompleted(
              h,
              'model_stop',
              `Completed: the ${s.mode === 'demo' ? 'demo player' : 'model'} chose to stop${outcome.explanation ? ` (“${outcome.explanation}”)` : ''}.`,
            );
          case 'bet':
          case 'skip': {
            h.consecutiveFailures = 0;
            h.roundInFlight = true;
            try {
              playRound(core.roundDeps, {
                sessionId: id,
                source: s.mode === 'demo' ? 'demo' : 'ai',
                decisionId: outcome.decisionId,
                bets: outcome.kind === 'bet' ? outcome.bets : [],
                idempotencyKey: `decision:${outcome.decisionId}`,
              });
            } finally {
              h.roundInFlight = false;
            }
            h.last = 'round';
            break;
          }
        }

        // Right after the round: Stop / Pause after round / the end of a Step / a reached limit end
        // the run now — no further decision follows, so nothing waits for the round pacing.
        s = flushRuntime(h);
        if (atBoundary(h, s)) return;
        // Round pacing (settings.roundPacingMs, independent of the animation speed), only because
        // another decision follows. Stop / shutdown / Pause end it early; a new value applies at once.
        await waitBetweenDecisions(h, () => core.presentationDelayMs(core.settings()));
      }
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      core.log(id, 'error', 'runner_error', `Runner stopped by an internal error: ${message}`);
      // A committed round is still owed its outcome and settlement.
      try {
        const latest = core.repo.getLatestRound(id);
        if (latest && latest.status !== 'settled') settleStoredRound(core.roundDeps, latest);
      } catch (settleErr) {
        core.log(id, 'error', 'runner_error', `Could not settle the open round: ${redact(String(settleErr))}`);
      }
      try {
        const s = core.repo.getSession(id);
        if (s?.status === 'stop_requested') finishStopped(h);
        else if (s && (s.status === 'running' || s.status === 'pause_requested')) {
          finishPaused(h, null, `Paused because of an internal error: ${message}`);
        }
      } catch {
        /* repository unavailable (shutdown); recovery will pause the session on next start */
      }
    } finally {
      deregister(h);
      core.emitSnapshot(id);
    }
  }

  function spawn(sessionId: string, step: boolean): void {
    const h: RunnerHandle = {
      sessionId,
      controller: new AbortController(),
      stepOnce: step,
      decisionInFlight: false,
      roundInFlight: false,
      consecutiveFailures: 0,
      last: 'none',
      wake: null,
      lastTick: core.now().getTime(),
      done: Promise.resolve(),
    };
    runners.set(sessionId, h);
    h.done = loop(h);
  }

  // ───────────── controls ─────────────

  return {
    start(sessionId, { step }) {
      if (shuttingDown) throw new GameError('invalid_state', 'The server is shutting down');
      const s = requireSession(sessionId);
      if (s.mode === 'manual') throw new GameError('invalid_state', 'Manual sessions are played with bets, not Start/Step');
      switch (s.status) {
        case 'running': {
          if (step) throw new GameError('invalid_state', 'The session is already running; use Pause first');
          // Start during a single step turns it into continuous play (same runner).
          const current = runners.get(sessionId);
          if (current?.stepOnce) {
            current.stepOnce = false;
            core.log(sessionId, 'info', 'session_started', 'Autonomous play continues after the current step');
          }
          return; // repeated Start: no-op, never a second runner
        }
        case 'pause_requested':
          if (step) throw new GameError('invalid_state', 'The session is pausing; wait for it to pause, then Step');
          // Start while a pause is pending: keep running (the existing runner continues).
          core.updateSession(sessionId, { status: 'running', message: null });
          core.log(sessionId, 'info', 'session_resumed', 'Pause request withdrawn; running');
          return;
        case 'stop_requested':
          throw new GameError('invalid_state', 'The session is stopping');
        case 'stopped':
        case 'completed':
          throw new GameError('invalid_state', `The session has ended (${s.endReason ?? s.status}); create a new session to play again`);
        case 'ready':
        case 'paused': {
          preflight(s);
          const existing = runners.get(sessionId);
          core.updateSession(sessionId, { status: 'running', pauseReason: null, message: null });
          core.log(sessionId, 'info', step ? 'session_step' : 'session_started', step ? 'Playing one round (step)' : 'Autonomous play started');
          if (existing) {
            // Defensive: never two loops for one session. A Step armed here plays its round now.
            existing.stepOnce = step;
            if (step) {
              existing.last = 'none';
              existing.wake?.abort('step');
            }
          } else spawn(sessionId, step);
          return;
        }
      }
    },

    pause(sessionId) {
      const s = requireSession(sessionId);
      if (s.mode === 'manual') throw new GameError('invalid_state', 'Manual sessions cannot be paused');
      switch (s.status) {
        case 'running': {
          const h = runners.get(sessionId);
          if (!h) {
            // No live runner (e.g. recovery has not run yet): nothing to finish, pause now.
            core.updateSession(sessionId, { status: 'paused', pauseReason: 'user_pause', phase: idlePhase(core.repo, sessionId), message: 'Paused.' });
            return;
          }
          core.updateSession(sessionId, { status: 'pause_requested', message: 'Pausing after the current round…' });
          core.log(sessionId, 'info', 'pause_requested', 'Pause requested; the current round will finish first');
          // Between rounds (pacing) or after a failed decision (backoff): pause now, not after the wait.
          h.wake?.abort('pause');
          return;
        }
        case 'pause_requested':
        case 'paused':
          return; // idempotent
        default:
          throw new GameError('invalid_state', `Cannot pause a session that is ${s.status}`);
      }
    },

    async stop(sessionId) {
      const s = requireSession(sessionId);
      if (s.status === 'stopped' || s.status === 'completed') return; // already ended: no-op
      const h = runners.get(sessionId);
      if (s.status === 'stop_requested') {
        if (h) await waitFor(h.done, STOP_WAIT_MS);
        return;
      }
      if (!h) {
        // Nothing in flight (ready / paused / manual): stop immediately.
        core.updateSession(sessionId, {
          status: 'stopped',
          endReason: 'user_stop',
          pauseReason: null,
          epoch: s.epoch + 1,
          phase: idlePhase(core.repo, sessionId),
          message: 'Stopped by user.',
        });
        core.log(sessionId, 'info', 'session_stopped', 'Session stopped by user');
        return;
      }
      // Epoch bump first so any response already on its way is recognised as stale.
      core.updateSession(sessionId, { status: 'stop_requested', epoch: s.epoch + 1, message: 'Stopping…' });
      core.log(sessionId, 'info', 'stop_requested', 'Stop requested; cancelling any in-flight request');
      h.controller.abort('stop');
      await waitFor(h.done, STOP_WAIT_MS);
    },

    settingsChanged() {
      for (const h of runners.values()) h.wake?.abort('settings');
    },

    inFlight(sessionId) {
      const h = runners.get(sessionId);
      return { decision: h?.decisionInFlight ?? false, round: h?.roundInFlight ?? false };
    },

    isRunning(sessionId) {
      return runners.has(sessionId);
    },

    async shutdown(waitMs) {
      shuttingDown = true;
      const handles = [...runners.values()];
      for (const h of handles) h.controller.abort('shutdown');
      await waitFor(Promise.allSettled(handles.map((h) => h.done)), waitMs);
    },

    size() {
      return runners.size;
    },
  };
}

/** "750 ms" / "4.2 s" for log messages. */
function formatWait(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** Resolve when `p` settles or after `ms`, whichever comes first (never rejects). */
function waitFor(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}
