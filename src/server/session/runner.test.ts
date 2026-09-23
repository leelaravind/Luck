/**
 * Runner edge cases: Stop during backoff, shutdown during a request, the adapter watchdog and
 * late results. TEST FIXTURES ONLY (fake adapters, scripted outcomes, injected clock/sleep).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCallResult } from '../types.js';
import { WATCHDOG_GRACE_MS, LATE_GIVE_UP_MS } from './aiDecision.js';
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
