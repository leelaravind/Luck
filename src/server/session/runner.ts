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
 *   check limits (BEFORE any request) → phase requesting_decision → exactly one decision
 *   → bet/skip: synchronous round flow (commit → draw → settle) → presentation wait
 *   → honour pause_requested / step / stop.
 * The presentation wait depends on the animation speed, which therefore only changes the time
 * between rounds — never the number of model calls (always exactly one decision per round).
 *
 * Stop: aborts an in-flight request (decision 'cancelled'; a late answer is recorded as stale and
 * never applied) or the presentation wait. A round whose bets were committed always settles
 * first (the round flow is synchronous), and no further round starts.
 */
import { GameError, type PauseReason, type SessionEndReason, type SessionInfo } from '../../shared/contracts.js';
import { redact } from '../redact.js';
import { resolveProviderConfig, serverGate } from '../providers/registry.js';
import { requestAiDecision, demoDecision, resolvePricing, type DecisionOutcome } from './aiDecision.js';
import { idlePhase, type SessionCore } from './core.js';
import { playRound, settleStoredRound } from './roundFlow.js';
import { waitAbortable, yieldToEventLoop } from './retry.js';

/** Kinds whose adapters need an explicit model to run. */
const MODEL_REQUIRED = new Set(['ollama', 'anthropic', 'openai']);
/** How long control('stop') waits for the runner to wind down before returning. */
export const STOP_WAIT_MS = 10_000;

interface RunnerHandle {
  readonly sessionId: string;
  readonly controller: AbortController;
  stepOnce: boolean;
  decisionInFlight: boolean;
  roundInFlight: boolean;
  /** Decisions in a row that failed after their bounded retries (reset by any usable decision). */
  consecutiveFailures: number;
  lastTick: number;
  done: Promise<void>;
}

export interface RunnerManager {
  start(sessionId: string, opts: { step: boolean }): void;
  pause(sessionId: string): void;
  /** Synchronous part of Stop; the returned promise resolves once the runner has wound down. */
  stop(sessionId: string): Promise<void>;
  inFlight(sessionId: string): { decision: boolean; round: boolean };
  isRunning(sessionId: string): boolean;
  /** Abort every runner (reason 'shutdown') and wait up to `waitMs` for them to exit. */
  shutdown(waitMs: number): Promise<void>;
  /** Test/diagnostic: number of live runners. */
  size(): number;
}

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
      const pricing = resolvePricing(core, kind, s.player, cfg.model);
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

  /** Honour a pending control request at a round boundary. Returns true when the loop must exit. */
  function atBoundary(h: RunnerHandle, s: SessionInfo): boolean {
    if (s.status === 'stop_requested') {
      finishStopped(h);
      return true;
    }
    if (h.controller.signal.aborted && h.controller.signal.reason === 'shutdown') {
      finishPaused(h, 'server_restart', 'Server shut down during the session. Press Start to resume.');
      return true;
    }
    if (s.status === 'pause_requested') {
      finishPaused(h, 'user_pause', 'Paused after the round, as requested.');
      return true;
    }
    if (s.status !== 'running') {
      deregister(h);
      return true;
    }
    return false;
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
      return { reason: 'insufficient_balance', message: `Completed: balance ${s.balance} is below the minimum stake of ${l.minStake} subunits.` };
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
        if (atBoundary(h, s)) return;

        const limit = limitReached(s);
        if (limit) return finishCompleted(h, limit.reason, limit.message);

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
          core.updateSession(id, { phase: idlePhase(core.repo, id) });
          continue;
        }

        switch (outcome.kind) {
          case 'blocked_budget':
            return finishCompleted(h, 'budget_exhausted', outcome.message);
          case 'failed': {
            // Each failed decision already used its bounded retries. Pause once the configured number
            // of consecutive failed decisions is reached (default 1 = pause after the first one).
            h.consecutiveFailures += 1;
            const allowed = Math.max(1, s.limits.maxConsecutiveFailures);
            if (h.consecutiveFailures >= allowed) return finishPaused(h, outcome.pauseReason, outcome.message);
            core.log(
              id,
              'warn',
              'decision_failed',
              `${outcome.message} (failed decision ${h.consecutiveFailures} of ${allowed} allowed in a row; no round was played)`,
            );
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
            break;
          }
        }

        // Presentation wait so the wheel can finish; abortable by Stop / shutdown (never by Pause).
        await waitAbortable(core.sleep, core.presentationDelayMs(core.settings().animationSpeed), h.controller.signal);
        s = flushRuntime(h);
        if (atBoundary(h, s)) return;
        if (h.stepOnce) return finishPaused(h, 'step_complete', 'Step complete: one round was played.');
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
          if (existing) existing.stepOnce = step; // defensive: never two loops for one session
          else spawn(sessionId, step);
          return;
        }
      }
    },

    pause(sessionId) {
      const s = requireSession(sessionId);
      if (s.mode === 'manual') throw new GameError('invalid_state', 'Manual sessions cannot be paused');
      switch (s.status) {
        case 'running':
          if (!runners.has(sessionId)) {
            // No live runner (e.g. recovery has not run yet): nothing to finish, pause now.
            core.updateSession(sessionId, { status: 'paused', pauseReason: 'user_pause', phase: idlePhase(core.repo, sessionId), message: 'Paused.' });
            return;
          }
          core.updateSession(sessionId, { status: 'pause_requested', message: 'Pausing after the current round…' });
          core.log(sessionId, 'info', 'pause_requested', 'Pause requested; the current round will finish first');
          return;
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
