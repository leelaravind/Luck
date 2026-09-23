/**
 * Runner edge cases: Stop during backoff, shutdown during a request, the adapter watchdog and
 * late results. TEST FIXTURES ONLY (fake adapters, scripted outcomes, injected clock/sleep).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCallResult } from '../types.js';
import { WATCHDOG_GRACE_MS, LATE_GIVE_UP_MS } from './aiDecision.js';
import { PAUSED_AFTER_ROUND, PAUSED_BEFORE_DECISION } from './runner.js';
import { defaultRoundPacingMs } from './service.js';
import { betDecision, deferred, failure, fakeAdapter, makeHarness, waitUntil, type Harness } from './__tests__/helpers.js';

const harnesses: Harness[] = [];
function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) {
    await h.service.shutdown();
    h.repo.close();
  }
});

const status = (h: Harness, id: string) => h.repo.getSession(id)!.status;

describe('runner edge cases (fixtures)', () => {
  it('Stop during a retry backoff cancels the decision without another attempt', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('unavailable', true) });
    const backoffStarted = deferred<void>();
    // Backoff sleep that only ends when aborted (Stop).
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (ms > 0) backoffStarted.resolve();
        if (ms === 0 || signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    const h = harness({ adapters: [adapter], sleep });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await backoffStarted.promise;

    const snap = await h.service.control(s.id, 'stop', h.key());
    expect(snap.session).toMatchObject({ status: 'stopped', endReason: 'user_stop', epoch: 1 });
    expect(adapter.calls).toHaveLength(1);
    expect(h.repo.listDecisions(s.id)[0]).toMatchObject({ status: 'cancelled', attempts: 1 });
    expect(h.repo.listUsage(s.id).map((u) => u.status)).toEqual(['error']);
  });

  it('#32: Stop during the wait between failed decisions ends the session without another request', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('rate_limited', true, { retryAfterMs: 20_000, httpStatus: 429 }) });
    const waitStarted = deferred<number>();
    // The wait only ends when aborted (Stop), like a real 20 s Retry-After.
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (ms === 0 || signal?.aborted) return resolve();
        waitStarted.resolve(ms);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    const h = harness({ adapters: [adapter], sleep });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' }, limits: { maxRetries: 0, maxConsecutiveFailures: 5 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    expect(await waitStarted.promise).toBe(20_000);
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'running', phase: 'ready' }); // not "requesting a decision" while waiting

    const snap = await h.service.control(s.id, 'stop', h.key());
    expect(snap.session).toMatchObject({ status: 'stopped', endReason: 'user_stop' });
    expect(adapter.calls).toHaveLength(1);
    expect(h.repo.listDecisions(s.id).map((d) => d.status)).toEqual(['failed']);
  });

  it('#32: shutdown during the wait between failed decisions pauses (server_restart) without another request', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('unavailable', true) });
    const waitStarted = deferred<void>();
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (ms === 0 || signal?.aborted) return resolve();
        waitStarted.resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    const h = harness({ adapters: [adapter], sleep });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' }, limits: { maxRetries: 0, maxConsecutiveFailures: 5 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitStarted.promise;
    await h.service.shutdown();
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'paused', pauseReason: 'server_restart' });
    expect(adapter.calls).toHaveLength(1);
  });

  it('shutdown during a request pauses the session (server_restart) and marks the decision interrupted', async () => {
    const adapter = fakeAdapter();
    const never = deferred<ProviderCallResult>();
    adapter.script.push(() => never.promise);
    const h = harness({ adapters: [adapter] });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'call');

    await h.service.shutdown();
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'paused', pauseReason: 'server_restart' });
    expect(h.repo.listDecisions(s.id)[0]!.status).toBe('interrupted');
    // The unanswered attempt is flushed as unknown usage; nothing was bet.
    expect(h.repo.listUsage(s.id)).toEqual([expect.objectContaining({ status: 'cancelled', known: false })]);
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
    await expect(h.service.control(s.id, 'start', h.key())).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('watchdog: an adapter that ignores its timeout is abandoned and retried; its late usage is recorded once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const adapter = fakeAdapter();
    const hung = deferred<ProviderCallResult>();
    adapter.script.push(() => hung.promise); // never honours timeoutMs
    adapter.script.push(() => betDecision([{ type: 'red', stake: 100 }]));
    const h = harness({ adapters: [adapter] });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' }, limits: { maxRounds: 1, decisionTimeoutMs: 1_000 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'first call');

    await vi.advanceTimersByTimeAsync(1_000 + WATCHDOG_GRACE_MS);
    await waitUntil(() => status(h, s.id) === 'completed', 'completed after retry');
    expect(adapter.calls).toHaveLength(2);
    expect(h.repo.getSession(s.id)!.roundsPlayed).toBe(1);
    expect(h.repo.listUsage(s.id).map((u) => [u.attempt, u.status])).toEqual([[2, 'ok']]);

    // The hung attempt is recorded when it gives up (unknown usage), exactly once.
    await vi.advanceTimersByTimeAsync(LATE_GIVE_UP_MS);
    await waitUntil(() => h.repo.listUsage(s.id).length === 2, 'late usage');
    hung.resolve(betDecision([{ type: 'black', stake: 100 }])); // arrives after give-up: ignored
    await new Promise((r) => setImmediate(r));
    const usage = h.repo.listUsage(s.id);
    expect(usage.map((u) => [u.attempt, u.status, u.known])).toEqual([
      [2, 'ok', true],
      [1, 'timeout', false],
    ]);
    expect(h.repo.listRounds(s.id)).toHaveLength(1);
  });

  it('epoch check: a result produced under an older epoch is discarded (stale) and never bet', async () => {
    let h!: Harness;
    let sessionId = '';
    const adapter = fakeAdapter();
    adapter.script.push(() => {
      // Simulate an epoch change (e.g. reset/session change) while the request is in flight.
      h.repo.updateSession(sessionId, { epoch: 7 });
      return betDecision([{ type: 'straight', numbers: [0], stake: 5_000 }]);
    });
    h = harness({ adapters: [adapter] });
    sessionId = h.service.createSession({ player: { kind: 'ollama', model: 'm' }, limits: { maxRounds: 1 } }, h.key()).session.id;
    await h.service.control(sessionId, 'start', h.key());
    await waitUntil(() => status(h, sessionId) === 'completed', 'completed');

    const decisions = [...h.repo.listDecisions(sessionId)].reverse();
    expect(decisions.map((d) => [d.epoch, d.status])).toEqual([
      [0, 'stale'],
      [7, 'accepted'],
    ]);
    const rounds = h.repo.listRounds(sessionId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.decisionId).toBe(decisions[1]!.id); // the stale straight-up bet was never placed
    expect(rounds[0]!.bets.map((b) => b.type)).toEqual(['red']);
    expect(h.repo.listUsage(sessionId).map((u) => u.status)).toEqual(['stale', 'ok']);
  });

  it('a result that arrives in the same tick as Stop is discarded as stale (epoch check)', async () => {
    const adapter = fakeAdapter();
    const d = deferred<ProviderCallResult>();
    adapter.script.push(() => d.promise);
    const h = harness({ adapters: [adapter] });
    const s = h.service.createSession({ player: { kind: 'ollama', model: 'm' } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'call');
    // Resolve first, then Stop synchronously: the runner sees the result with a newer epoch.
    d.resolve(betDecision([{ type: 'red', stake: 100 }]));
    const stop = h.service.control(s.id, 'stop', h.key());
    await stop;
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'stopped', epoch: 1 });
    expect(['stale', 'cancelled']).toContain(h.repo.listDecisions(s.id)[0]!.status);
    await waitUntil(() => h.repo.listUsage(s.id).length === 1, 'usage');
    expect(h.repo.listUsage(s.id)[0]!.status).toBe('stale');
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
  });
});

// ───────────── waits between decisions never hold up a control (V3/V4 regressions) ─────────────

/**
 * A sleep that NEVER elapses on its own (think: a 60 s round pacing or a 30 s Retry-After); it only
 * ends when its signal is aborted. If the runner waited before honouring a control, the test would
 * hang, so every assertion below proves the control took effect without the wait.
 */
function hangingSleep() {
  const waits: { ms: number; ended: boolean }[] = [];
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve();
      const w = { ms, ended: false };
      waits.push(w);
      signal?.addEventListener(
        'abort',
        () => {
          w.ended = true;
          resolve();
        },
        { once: true },
      );
    });
  return { sleep, waits };
}

const PACING_60S = 60_000;
const fixturePlayer = { kind: 'ollama' as const, model: 'fixture-model' };
const macrotasks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe('waits between decisions never hold up a control (60 s round pacing, fixtures)', () => {
  function paced(adapterOpts: Parameters<typeof fakeAdapter>[0] = {}) {
    const adapter = fakeAdapter(adapterOpts);
    const { sleep, waits } = hangingSleep();
    const h = harness({ adapters: [adapter], sleep, presentationDelayMs: defaultRoundPacingMs });
    h.service.updateSettings({ roundPacingMs: PACING_60S });
    return { adapter, waits, h };
  }

  it('Next round (step) pauses as soon as its round settles: no pacing wait is even started', async () => {
    const { adapter, waits, h } = paced();
    const s = h.service.createSession({ player: fixturePlayer }, h.key()).session;
    await h.service.control(s.id, 'step', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'step complete', 2_000);
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'step_complete', roundsPlayed: 1 });
    expect(waits).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it('the last allowed round completes the session at once (no pacing wait after it)', async () => {
    const { adapter, waits, h } = paced();
    const s = h.service.createSession({ player: fixturePlayer, limits: { maxRounds: 1 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed', 2_000);
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'max_rounds', roundsPlayed: 1 });
    expect(waits).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it('Pause after round during the 60 s pacing wait pauses immediately ("Paused after the round")', async () => {
    const { adapter, waits, h } = paced();
    const s = h.service.createSession({ player: fixturePlayer }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => waits.length === 1, 'pacing wait started', 2_000);
    expect(waits[0]).toEqual({ ms: PACING_60S, ended: false });

    await h.service.control(s.id, 'pause', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused', 2_000);
    expect(waits[0]!.ended).toBe(true);
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'user_pause', message: PAUSED_AFTER_ROUND, roundsPlayed: 1 });
    expect(adapter.calls).toHaveLength(1); // no further decision was requested
  });

  it('Pause during a failed-decision Retry-After wait pauses immediately ("Paused before the next decision")', async () => {
    const { adapter, waits, h } = paced({ fallback: () => failure('rate_limited', true, { retryAfterMs: 30_000, httpStatus: 429 }) });
    const s = h.service.createSession({ player: fixturePlayer, limits: { maxRetries: 0, maxConsecutiveFailures: 5 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => waits.length === 1, 'Retry-After wait started', 2_000);
    expect(waits[0]).toEqual({ ms: 30_000, ended: false });

    await h.service.control(s.id, 'pause', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused', 2_000);
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'user_pause', message: PAUSED_BEFORE_DECISION, roundsPlayed: 0 });
    expect(adapter.calls).toHaveLength(1);
    const paused = h.service.listLogs(s.id).filter((l) => l.type === 'session_paused');
    expect(paused.map((l) => l.message)).toEqual([PAUSED_BEFORE_DECISION]);
  });

  it('Pause during a decision that then fails: paused at once, without starting the backoff wait', async () => {
    const { adapter, waits, h } = paced();
    const answer = deferred<ProviderCallResult>();
    adapter.script.push(() => answer.promise);
    const s = h.service.createSession({ player: fixturePlayer, limits: { maxRetries: 0, maxConsecutiveFailures: 5 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'call', 2_000);
    expect((await h.service.control(s.id, 'pause', h.key())).session.status).toBe('pause_requested');
    answer.resolve(failure('rate_limited', true, { retryAfterMs: 30_000, httpStatus: 429 }));
    await waitUntil(() => status(h, s.id) === 'paused', 'paused', 2_000);
    expect(waits).toEqual([]);
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'user_pause', message: PAUSED_BEFORE_DECISION, roundsPlayed: 0 });
    // The failure is logged, but without a promise of another decision that never comes.
    const failed = h.service.listLogs(s.id).filter((l) => l.type === 'decision_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).not.toMatch(/keeps running|next decision in/);
  });

  it('a changed roundPacingMs applies to the wait in progress (measured from its start)', async () => {
    const { adapter, waits, h } = paced();
    const s = h.service.createSession({ player: fixturePlayer, limits: { maxRounds: 2 } }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => waits.length === 1, 'pacing wait started', 2_000);

    h.clock.advance(10_000); // 10 s of the 60 s wait have passed
    h.service.updateSettings({ roundPacingMs: 30_000 });
    await waitUntil(() => waits.length === 2, 'wait re-armed', 2_000);
    expect(waits.map((w) => [w.ms, w.ended])).toEqual([
      [PACING_60S, true],
      [20_000, false], // the remaining 20 s of the new 30 s
    ]);
    expect(adapter.calls).toHaveLength(1);

    h.service.updateSettings({ roundPacingMs: 5_000 }); // already more than 5 s waited: go on now
    await waitUntil(() => status(h, s.id) === 'completed', 'completed', 2_000);
    expect(adapter.calls).toHaveLength(2);
    expect(waits).toHaveLength(2);
  });

  it('a Pause withdrawn by Start before the runner saw it keeps the pacing wait (no early decision); Stop ends it', async () => {
    const { adapter, waits, h } = paced();
    const s = h.service.createSession({ player: fixturePlayer }, h.key()).session;
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => waits.length === 1, 'pacing wait started', 2_000);

    // Same tick: the runner only resumes after both controls were handled.
    await Promise.all([h.service.control(s.id, 'pause', h.key()), h.service.control(s.id, 'start', h.key())]);
    await macrotasks(5);
    expect(status(h, s.id)).toBe('running');
    expect(adapter.calls).toHaveLength(1);
    expect(waits.map((w) => [w.ms, w.ended])).toEqual([
      [PACING_60S, true],
      [PACING_60S, false], // the clock did not move: the full remaining time
    ]);

    const snap = await h.service.control(s.id, 'stop', h.key());
    expect(snap.session).toMatchObject({ status: 'stopped', endReason: 'user_stop', roundsPlayed: 1 });
    expect(waits[1]!.ended).toBe(true);
    expect(adapter.calls).toHaveLength(1);
  });
});
