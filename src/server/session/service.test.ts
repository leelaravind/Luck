/**
 * Session service / runner tests.
 *
 * TEST FIXTURES ONLY: fake provider adapters with scripted (deferred) answers, a scripted outcome
 * source (createFixtureOutcomeSource), an in-memory SQLite repository, an injected clock and
 * instant sleeps. No real provider is contacted and no real randomness is used.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  GameError,
  type AiProviderKind,
  type RoundRecord,
  type ServerEvent,
  type SessionLimits,
} from '../../shared/contracts.js';
import { validateBetSlip } from '../../shared/bets.js';
import { openRepository } from '../db/sqlite.js';
import { createFixtureOutcomeSource } from '../engine/fixtureOutcome.js';
import { clearRegisteredSecrets, registerSecret } from '../redact.js';
import type { OutcomeSource, ProviderAdapter, ProviderCallResult } from '../types.js';
import { MAX_PROVIDER_NOTE_CHARS, REASONING_ONLY_OUTPUT } from './aiDecision.js';
import { PAUSED_AFTER_FAILURE } from './runner.js';
import { createGameService, createSessionFingerprint, defaultRoundPacingMs } from './service.js';
import { DEFAULT_ROUND_PACING_MS } from './settings.js';
import {
  betDecision,
  deferred,
  failure,
  FAKE_ANTHROPIC_KEY,
  fakeAdapter,
  makeHarness,
  okDecision,
  okText,
  outcomeScript,
  testConfig,
  waitUntil,
  type Harness,
} from './__tests__/helpers.js';

const harnesses: Harness[] = [];
function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.service.shutdown();
    h.repo.close();
  }
});

function createAi(h: Harness, limits: Partial<SessionLimits> = {}, player: Record<string, unknown> = {}) {
  return h.service.createSession({ player: { kind: 'ollama', model: 'fixture-model', ...player } as never, limits }, h.key()).session;
}

const status = (h: Harness, id: string) => h.repo.getSession(id)!.status;
const settledRounds = (h: Harness, id: string) => h.repo.listRounds(id).filter((r) => r.status === 'settled');

// ───────────────────────────── manual play ─────────────────────────────

describe('manual round flow', () => {
  it('commits, draws, settles and credits exactly once; replaying the key is a no-op', () => {
    const h = harness({ outcomes: [17, 3] });
    const { session } = h.service.createSession({ player: { kind: 'manual' } }, h.key());
    expect(session).toMatchObject({ mode: 'manual', status: 'ready', balance: 100_000 });

    const bets = [
      { type: 'straight' as const, numbers: [17], stake: 100 },
      { type: 'red' as const, stake: 200 },
    ];
    const r1 = h.service.placeManualRound(session.id, bets, 'round-key-1');
    expect(r1.round).toMatchObject({ status: 'settled', winningNumber: 17, totalStake: 300, seq: 1 });
    // 17 is black: straight wins 100 × 35 + stake, red loses.
    expect(r1.round.totalReturned).toBe(3_600);
    expect(r1.round.net).toBe(3_300);
    expect(r1.snapshot.session.balance).toBe(103_300);
    expect(h.outcome.calls).toBe(1);

    const replay = h.service.placeManualRound(session.id, bets, 'round-key-1');
    expect(replay.round.id).toBe(r1.round.id);
    expect(replay.snapshot.session.balance).toBe(103_300);
    expect(h.outcome.calls).toBe(1); // no new outcome
    expect(h.repo.listLedger(session.id).filter((l) => l.kind === 'stake')).toHaveLength(1);
    expect(h.repo.listLedger(session.id).filter((l) => l.kind === 'payout')).toHaveLength(1);
  });

  it('D3: the same Idempotency-Key with a DIFFERENT slip is refused (409); the same slip in another order replays', () => {
    const h = harness({ outcomes: [17] });
    const { session } = h.service.createSession({ player: { kind: 'manual' } }, h.key());
    const slip = [
      { type: 'red' as const, stake: 100 },
      { type: 'split' as const, numbers: [3, 0], stake: 50 },
    ];
    const first = h.service.placeManualRound(session.id, slip, 'k-d3');
    // Same positions and stakes, different order and number order → a genuine replay.
    const replay = h.service.placeManualRound(session.id, [{ type: 'split', numbers: [0, 3], stake: 50 }, { type: 'red', stake: 100 }], 'k-d3');
    expect(replay.round.id).toBe(first.round.id);
    // Different slip under the same key → duplicate_request, nothing charged, no new outcome.
    expect(() => h.service.placeManualRound(session.id, [{ type: 'black', stake: 100 }], 'k-d3')).toThrow(
      expect.objectContaining({ code: 'duplicate_request' }),
    );
    expect(() => h.service.placeManualRound(session.id, [{ type: 'red', stake: 110 }, { type: 'split', numbers: [0, 3], stake: 50 }], 'k-d3')).toThrow(
      expect.objectContaining({ code: 'duplicate_request' }),
    );
    expect(h.repo.listRounds(session.id)).toHaveLength(1);
    expect(h.outcome.calls).toBe(1);
    expect(h.repo.getSession(session.id)!.balance).toBe(first.snapshot.session.balance);
  });

  it('validates bets on the backend and never repairs them', () => {
    const h = harness();
    const { session } = h.service.createSession({ player: { kind: 'manual' } }, h.key());
    expect(() => h.service.placeManualRound(session.id, [{ type: 'split', numbers: [1, 3], stake: 100 }], 'k1')).toThrow(GameError);
    expect(() => h.service.placeManualRound(session.id, [{ type: 'red', stake: 15 }], 'k2')).toThrow(/multiple/);
    expect(() => h.service.placeManualRound(session.id, [{ type: 'red', stake: 200_000 }], 'k3')).toThrow(GameError);
    expect(h.repo.listRounds(session.id)).toHaveLength(0);
    expect(h.outcome.calls).toBe(0);
    expect(h.repo.getSession(session.id)!.balance).toBe(100_000);
  });

  it('rejects manual bets in autonomous sessions and completes at maxRounds', () => {
    const h = harness({ outcomes: [1, 2] });
    const demo = h.service.createSession({ player: { kind: 'demo' } }, h.key()).session;
    expect(() => h.service.placeManualRound(demo.id, [{ type: 'red', stake: 100 }], 'x')).toThrow(/manual session/);

    const manual = h.service.createSession({ player: { kind: 'manual' }, limits: { maxRounds: 1 } }, h.key()).session;
    const r = h.service.placeManualRound(manual.id, [{ type: 'red', stake: 100 }], 'y');
    expect(r.snapshot.session).toMatchObject({ status: 'completed', endReason: 'max_rounds' });
    expect(() => h.service.placeManualRound(manual.id, [{ type: 'red', stake: 100 }], 'z')).toThrow(/completed/);
  });

  it('draws the outcome only after the bets are committed (spy ordering)', () => {
    const order: string[] = [];
    const fixture = createFixtureOutcomeSource([22]);
    const repo = openRepository(':memory:');
    const spySource: OutcomeSource & { calls: number } = {
      kind: 'fixture',
      get calls() {
        return fixture.calls;
      },
      next() {
        // At draw time the round and its stake must already be persisted.
        const latest = repo.listRounds(sessionId)[0];
        order.push(`draw(status=${latest?.status},bets=${latest?.bets.length},balance=${repo.getSession(sessionId)!.balance})`);
        return fixture.next();
      },
    };
    const commit = repo.commitRound.bind(repo);
    repo.commitRound = (input) => {
      order.push('commit');
      return commit(input);
    };
    const h = harness({ repo, outcomeSource: spySource });
    const sessionId = h.service.createSession({ player: { kind: 'manual' } }, h.key()).session.id;
    h.service.placeManualRound(sessionId, [{ type: 'even', stake: 500 }], 'k');
    expect(order).toEqual(['commit', 'draw(status=committed,bets=1,balance=99500)']);
  });

  it('rejects secrets and inconsistent limits at session creation; create is idempotent', () => {
    const h = harness();
    expect(() => h.service.createSession({ player: { kind: 'anthropic', apiKey: 'sk-ant-x' } as never }, h.key())).toThrow(GameError);
    expect(() => h.service.createSession({ player: { kind: 'manual' }, limits: { minStake: 15 } }, h.key())).toThrow(/multiple of stakeIncrement/);
    const a = h.service.createSession({ player: { kind: 'manual' } }, 'same');
    const b = h.service.createSession({ player: { kind: 'manual' } }, 'same');
    expect(b.session.id).toBe(a.session.id);
    expect(h.service.listSessions()).toHaveLength(1);
  });

  it('#22: the same Idempotency-Key with a DIFFERENT request is refused (409); the same request replays', () => {
    const h = harness();
    const req = { name: 'first', player: { kind: 'manual' as const }, limits: { maxRounds: 5, minStake: 20 } };
    const first = h.service.createSession(req, 'create-key');
    // Same request, keys in another order → a genuine replay (canonical fingerprint).
    const replay = h.service.createSession({ limits: { minStake: 20, maxRounds: 5 }, player: { kind: 'manual' }, name: 'first' }, 'create-key');
    expect(replay.session.id).toBe(first.session.id);
    expect(replay).toEqual(h.service.getSnapshot(first.session.id));
    for (const different of [
      { ...req, name: 'second' },
      { ...req, limits: { maxRounds: 6, minStake: 20 } },
      { ...req, player: { kind: 'demo' as const } },
    ]) {
      expect(() => h.service.createSession(different, 'create-key')).toThrow(
        expect.objectContaining({ code: 'duplicate_request', details: { sessionId: first.session.id } }),
      );
    }
    expect(h.service.listSessions()).toHaveLength(1);
    // A replay still works after the default limits changed (the fingerprint covers the request as sent).
    h.service.updateSettings({ defaultLimits: { ...DEFAULT_LIMITS, maxRounds: 99, minStake: 50, stakeIncrement: 50 } });
    expect(h.service.createSession(req, 'create-key').session.id).toBe(first.session.id);
    // An invalid request under a used key is still a validation error, not a replay.
    expect(() => h.service.createSession({ player: { kind: 'manual' }, limits: { minStake: -1 } }, 'create-key')).toThrow(
      expect.objectContaining({ code: 'validation_error' }),
    );
  });

  it('#23: the session and its idempotency record are written by ONE repository transaction', () => {
    const repo = openRepository(':memory:');
    const calls: string[] = [];
    const createSession = repo.createSession.bind(repo);
    const createIdem = repo.createSessionIdempotent.bind(repo);
    const putIdempotent = repo.putIdempotent.bind(repo);
    repo.createSession = (input) => (calls.push('createSession'), createSession(input));
    repo.putIdempotent = (scope, key, value) => (calls.push('putIdempotent'), putIdempotent(scope, key, value));
    repo.createSessionIdempotent = (input, idem) => (calls.push('createSessionIdempotent'), createIdem(input, idem));
    const h = harness({ repo });
    const req = { player: { kind: 'manual' as const } };
    const { session } = h.service.createSession(req, 'k-atomic');
    expect(calls).toEqual(['createSessionIdempotent']);
    expect(repo.getIdempotent('create-session', 'k-atomic')).toEqual({ sessionId: session.id, fingerprint: createSessionFingerprint(req) });
    // A failing transaction leaves neither a session nor a record behind, so a retry creates exactly one.
    repo.createSessionIdempotent = () => {
      throw new GameError('internal', 'simulated crash inside the transaction');
    };
    expect(() => h.service.createSession(req, 'k-crash')).toThrow(/simulated crash/);
    expect(repo.getIdempotent('create-session', 'k-crash')).toBeNull();
    expect(h.service.listSessions()).toHaveLength(1);
    repo.createSessionIdempotent = createIdem;
    const retried = h.service.createSession(req, 'k-crash');
    expect(h.service.createSession(req, 'k-crash').session.id).toBe(retried.session.id);
    expect(h.service.listSessions()).toHaveLength(2);
  });

  it('fingerprints are canonical: key order does not matter, content does', () => {
    const a = createSessionFingerprint({ name: 'x', player: { kind: 'ollama', model: 'm' }, limits: { maxRounds: 3, minStake: 10 } });
    const b = createSessionFingerprint({ limits: { minStake: 10, maxRounds: 3 }, player: { model: 'm', kind: 'ollama' }, name: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(createSessionFingerprint({ player: { kind: 'ollama', model: 'm2' } })).not.toBe(createSessionFingerprint({ player: { kind: 'ollama', model: 'm' } }));
    // No name and an empty name both mean "default name".
    expect(createSessionFingerprint({ name: '', player: { kind: 'manual' } })).toBe(createSessionFingerprint({ player: { kind: 'manual' } }));
  });

  it('#27: the round log shows credits (V$), never raw subunits', () => {
    const h = harness({ outcomes: [17] });
    const { session } = h.service.createSession({ player: { kind: 'manual' } }, h.key());
    h.service.placeManualRound(session.id, [{ type: 'straight', numbers: [17], stake: 10 }], 'k-log');
    const log = h.service.listLogs(session.id).find((l) => l.type === 'round_settled')!;
    expect(log.message).toBe('Round 1: 17 — staked V$ 0.10, returned V$ 3.60, net +V$ 3.50');
    const loss = harness({ outcomes: [0] });
    const s2 = loss.service.createSession({ player: { kind: 'manual' }, limits: { startingBalance: 100, minStake: 100, stakeIncrement: 100 } }, loss.key()).session;
    loss.service.placeManualRound(s2.id, [{ type: 'red', stake: 100 }], 'k-loss');
    const messages = loss.service.listLogs(s2.id).map((l) => l.message);
    expect(messages).toContain('Round 1: 0 — staked V$ 1.00, returned V$ 0.00, net −V$ 1.00');
    expect(loss.repo.getSession(s2.id)!.message).toBe('Completed: balance V$ 0.00 is below the minimum stake of V$ 1.00.');
  });
});

// ───────────────────────────── demo player ─────────────────────────────

describe('demo session (rule-based demo player, fixture outcomes)', () => {
  it('runs to maxRounds; balance equals the ledger; decisions are labelled demo', async () => {
    const h = harness();
    const { session } = h.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 12 } }, h.key());
    await h.service.control(session.id, 'start', h.key());
    await waitUntil(() => status(h, session.id) === 'completed', 'demo completion');

    const s = h.repo.getSession(session.id)!;
    expect(s).toMatchObject({ endReason: 'max_rounds', roundsPlayed: 12 });
    const rounds = h.repo.listRounds(session.id);
    expect(rounds).toHaveLength(12);
    expect(rounds.every((r) => r.status === 'settled' && r.source === 'demo')).toBe(true);
    const types = [...rounds].reverse().map((r) => r.bets[0]!.type);
    expect(types.slice(0, 7)).toEqual(['red', 'black', 'odd', 'even', 'low', 'high', 'red']);

    const net = rounds.reduce((sum, r) => sum + (r.net ?? 0), 0);
    expect(s.balance).toBe(s.startingBalance + net);
    const ledger = h.repo.listLedger(session.id);
    expect(ledger.reduce((sum, e) => sum + e.amount, 0)).toBe(s.balance);
    expect(ledger.at(-1)!.balanceAfter).toBe(s.balance);

    const decisions = h.repo.listDecisions(session.id);
    expect(decisions).toHaveLength(12);
    expect(decisions.every((d) => d.providerKind === 'demo' && d.status === 'accepted')).toBe(true);
    expect(decisions[0]!.explanation).toMatch(/Rule-based demo player \(not AI\)/);
    expect(h.service.getUsage(session.id)).toMatchObject({ records: [], summary: { requests: 0, costBasis: 'not-applicable' } });
  });

  it('completes with insufficient_balance when the balance drops below minStake', async () => {
    // Demo flat stake is 1 credit (100) > balance 10: it stakes the remaining legal amount (10) instead of
    // skipping forever (reviewer A11b-N2) and never bets beyond its balance. Fixture 17 is black → red loses.
    const h = harness({ outcomes: [17] });
    const { session } = h.service.createSession({ player: { kind: 'demo' }, limits: { startingBalance: 10, minStake: 10, maxRounds: null } }, h.key());
    await h.service.control(session.id, 'start', h.key());
    await waitUntil(() => status(h, session.id) === 'completed', 'short-stack completion');
    const [only] = h.repo.listRounds(session.id);
    expect(only).toMatchObject({ totalStake: 10, net: -10 });
    expect(only!.bets).toMatchObject([{ type: 'red', stake: 10 }]);
    expect(h.repo.getSession(session.id)).toMatchObject({ endReason: 'insufficient_balance', balance: 0, roundsPlayed: 1 });

    const h2 = harness({ outcomes: [17] });
    const poor = h2.service.createSession({ player: { kind: 'demo' }, limits: { startingBalance: 100, minStake: 100, stakeIncrement: 100, maxStakePerBet: 100, maxStakePerRound: 100 } }, h2.key()).session;
    await h2.service.control(poor.id, 'start', h2.key());
    await waitUntil(() => status(h2, poor.id) === 'completed', 'poor completion');
    // Fixture outcome 17 is black: the round-1 bet on red loses the whole balance.
    expect(h2.repo.getSession(poor.id)).toMatchObject({ endReason: 'insufficient_balance', balance: 0, roundsPlayed: 1 });
    expect(h2.outcome.calls).toBe(1);
  });
});

// ───────────────────────────── autonomous AI ─────────────────────────────

describe('autonomous AI runner (fake adapter fixtures)', () => {
  it('sends only the GameObservation; the pending round and secrets never reach the adapter', async () => {
    const adapter = fakeAdapter({ kind: 'anthropic', paid: true });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 3 }, { kind: 'anthropic', model: 'claude-sonnet-4-6' });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completion');

    expect(adapter.calls).toHaveLength(3);
    for (const [i, { req, cfg }] of adapter.calls.entries()) {
      expect(Object.keys(req.observation).sort()).toEqual(
        ['balance', 'betTypes', 'game', 'history', 'limits', 'roundNumber', 'rules', 'schemaVersion', 'stats', 'units'].sort(),
      );
      expect(req.observation.roundNumber).toBe(i + 1);
      expect(req.observation.history).toHaveLength(i); // settled rounds only
      const wire = JSON.stringify({ o: req.observation, s: req.systemPrompt, u: req.userPrompt });
      expect(wire).not.toContain(s.id);
      expect(wire).not.toContain(FAKE_ANTHROPIC_KEY);
      for (const r of h.repo.listRounds(s.id)) expect(wire).not.toContain(r.id);
      expect(cfg.apiKey).toBe(FAKE_ANTHROPIC_KEY); // server-side config reaches the adapter only
    }
    // The observation for round 2 includes round 1's settled result.
    const r1 = h.repo.listRounds(s.id).find((r) => r.seq === 1)!;
    expect(adapter.calls[1]!.req.observation.history[0]).toMatchObject({ round: 1, winningNumber: r1.winningNumber });
  });

  it('pause during a decision finishes that round, then pauses', async () => {
    const adapter = fakeAdapter();
    const d = deferred<ProviderCallResult>();
    adapter.script.push(() => d.promise);
    const h = harness({ adapters: [adapter] });
    const s = createAi(h);
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'first call');

    const snap = await h.service.control(s.id, 'pause', h.key());
    expect(snap.session.status).toBe('pause_requested');
    expect(snap.inFlight.decision).toBe(true);
    d.resolve(betDecision([{ type: 'black', stake: 100 }]));
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');

    const after = h.repo.getSession(s.id)!;
    expect(after).toMatchObject({ pauseReason: 'user_pause', roundsPlayed: 1 });
    expect(adapter.calls).toHaveLength(1);
    expect(settledRounds(h, s.id)).toHaveLength(1);

    // Resume continues with exactly one more decision per round.
    await h.service.control(s.id, 'step', h.key());
    await waitUntil(() => h.repo.getSession(s.id)!.pauseReason === 'step_complete', 'step');
    expect(adapter.calls).toHaveLength(2);
    expect(h.repo.getSession(s.id)!.roundsPlayed).toBe(2);
  });

  it('step plays exactly one round then pauses with step_complete', async () => {
    const adapter = fakeAdapter();
    const h = harness({ adapters: [adapter] });
    const s = createAi(h);
    const snap = await h.service.control(s.id, 'step', h.key());
    expect(snap.session.status).toBe('running');
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'step_complete', roundsPlayed: 1 });
    expect(adapter.calls).toHaveLength(1);
    await expect(h.service.control(s.id, 'pause', h.key())).resolves.toBeTruthy(); // paused → pause is a no-op
  });

  it('stop during an in-flight decision: cancelled, no round, late answer recorded as stale, epoch bumped', async () => {
    const adapter = fakeAdapter();
    const late = deferred<ProviderCallResult>();
    adapter.script.push(() => late.promise); // ignores the abort signal on purpose
    const h = harness({ adapters: [adapter] });
    const s = createAi(h);
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'call');

    const snap = await h.service.control(s.id, 'stop', h.key());
    expect(snap.session).toMatchObject({ status: 'stopped', endReason: 'user_stop', epoch: 1 });
    expect(adapter.calls[0]!.signal.aborted).toBe(true);
    expect(h.repo.listDecisions(s.id)[0]!.status).toBe('cancelled');
    expect(h.repo.listUsage(s.id)).toHaveLength(0); // not yet answered

    late.resolve(betDecision([{ type: 'red', stake: 100 }]));
    await waitUntil(() => h.repo.listUsage(s.id).length === 1, 'late usage');
    const usage = h.repo.listUsage(s.id)[0]!;
    expect(usage).toMatchObject({ status: 'stale', known: true, inputTokens: 1_000 });
    const decision = h.repo.listDecisions(s.id)[0]!;
    expect(decision.status).toBe('stale');
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
    expect(h.repo.getSession(s.id)!.balance).toBe(100_000);
    expect(h.outcome.calls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
  });

  it('stop after the bets are committed: that round settles and no further round starts', async () => {
    const adapter = fakeAdapter();
    const h = harness({ adapters: [adapter] });
    const s = createAi(h);
    const stopKey = h.key();
    let stopPromise: Promise<unknown> | null = null;
    h.service.subscribe(s.id, (ev: ServerEvent) => {
      if (ev.type === 'round' && ev.round.status === 'committed' && !stopPromise) {
        stopPromise = h.service.control(s.id, 'stop', stopKey); // Stop arrives right after the commit
      }
    });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'stopped', 'stopped');
    await stopPromise;

    const rounds = h.repo.listRounds(s.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe('settled');
    expect(adapter.calls).toHaveLength(1);
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'user_stop', roundsPlayed: 1 });
  });

  it('repeated start never creates a second runner; at most one decision is in flight', async () => {
    const adapter = fakeAdapter({
      fallback: async () => {
        await new Promise((r) => setImmediate(r));
        return betDecision([{ type: 'odd', stake: 100 }]);
      },
    });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 6 });
    const key = h.key();
    await Promise.all([
      h.service.control(s.id, 'start', key),
      h.service.control(s.id, 'start', key), // replayed key
      h.service.control(s.id, 'start', h.key()),
      h.service.control(s.id, 'start', h.key()),
    ]);
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(adapter.maxInFlight).toBe(1);
    expect(adapter.calls).toHaveLength(6); // exactly one decision per round
    expect(h.repo.getSession(s.id)!.roundsPlayed).toBe(6);
    await expect(h.service.control(s.id, 'pause', key)).rejects.toMatchObject({ code: 'duplicate_request' });
  });

  it('#4: the wait between rounds is roundPacingMs; the animation speed never changes it (or the call count)', async () => {
    const runWith = async (patch: { animationSpeed?: 'normal' | 'fast' | 'instant'; roundPacingMs?: number }) => {
      const adapter = fakeAdapter();
      // The production rule (defaultRoundPacingMs), not a test stub.
      const h = harness({ adapters: [adapter], presentationDelayMs: defaultRoundPacingMs });
      h.service.updateSettings(patch);
      const s = createAi(h, { maxRounds: 4 });
      await h.service.control(s.id, 'start', h.key());
      await waitUntil(() => status(h, s.id) === 'completed', 'completed');
      return { calls: adapter.calls.length, sleeps: h.sleeps };
    };
    const normal = await runWith({ animationSpeed: 'normal' });
    const instant = await runWith({ animationSpeed: 'instant' });
    const fast = await runWith({ animationSpeed: 'fast' });
    // 4 rounds → 3 waits between them. The last round reaches maxRounds, so the session completes at
    // once: no pacing wait after it (no further decision needs one).
    for (const r of [normal, instant, fast]) {
      expect(r.calls).toBe(4);
      expect(r.sleeps).toEqual([DEFAULT_ROUND_PACING_MS, DEFAULT_ROUND_PACING_MS, DEFAULT_ROUND_PACING_MS]);
    }
    expect(DEFAULT_ROUND_PACING_MS).toBe(7_000);
    // Changing roundPacingMs does change it (0 = no wait at all), with the same one call per round.
    const quick = await runWith({ animationSpeed: 'normal', roundPacingMs: 250 });
    expect(quick).toEqual({ calls: 4, sleeps: [250, 250, 250] });
    const none = await runWith({ roundPacingMs: 0 });
    expect(none).toEqual({ calls: 4, sleeps: [] });
  });

  it('with allowModelStop, model "stop" completes the session with model_stop; "skip" plays a no-bet round', async () => {
    const adapter = fakeAdapter();
    adapter.script.push(() => okDecision({ action: 'skip', explanation: 'sitting out' }));
    adapter.script.push(() => okDecision({ action: 'stop', explanation: 'done' }));
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { allowModelStop: true });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'model_stop', roundsPlayed: 1, balance: 100_000 });
    const [skipRound] = h.repo.listRounds(s.id);
    expect(skipRound).toMatchObject({ status: 'settled', totalStake: 0, net: 0, source: 'ai' });
    expect(skipRound!.bets).toEqual([]);
  });

  it('by default the model cannot end the session: "stop" is rejected (never converted), the session pauses', async () => {
    const adapter = fakeAdapter({ fallback: () => okDecision({ action: 'stop', explanation: 'protect the balance' }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 1 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');
    const after = h.repo.getSession(s.id)!;
    expect(after.pauseReason).toBe('invalid_output');
    expect(after.endReason).toBeNull();
    expect(adapter.calls).toHaveLength(2);
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
    const [d] = h.repo.listDecisions(s.id);
    expect(d!.validationErrors.join(' ')).toMatch(/"stop" is not available/);
  });
});

// ───────────────────────────── failures, retries, budget ─────────────────────────────

describe('provider failures, invalid output and budgets (fake adapter fixtures)', () => {
  it('retryable provider failure: exactly 1 + maxRetries attempts, backoff, then paused provider_error', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('server_error', true, { httpStatus: 503 }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 2 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');

    expect(adapter.calls).toHaveLength(3);
    const after = h.repo.getSession(s.id)!;
    expect(after.pauseReason).toBe('provider_error');
    expect(after.message).toMatch(/failed after 3 attempts/);
    const usage = h.repo.listUsage(s.id);
    expect(usage.map((u) => [u.attempt, u.status, u.known])).toEqual([
      [1, 'error', false],
      [2, 'error', false],
      [3, 'error', false],
    ]);
    expect(h.repo.listDecisions(s.id)[0]).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'server_error' });
    const backoffs = h.sleeps.filter((ms) => ms > 0);
    expect(backoffs).toHaveLength(2);
    expect(backoffs[0]).toBeGreaterThanOrEqual(1_000);
    expect(backoffs[0]).toBeLessThan(1_250);
    expect(backoffs[1]).toBeGreaterThanOrEqual(2_000);
    expect(backoffs[1]).toBeLessThan(2_500);
    // Never falls back to the demo player; no bet, no outcome.
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
    expect(h.repo.listDecisions(s.id).some((d) => d.providerKind === 'demo')).toBe(false);
    expect(h.outcome.calls).toBe(0);
    expect(h.service.getUsage(s.id).summary).toMatchObject({ requests: 3, failedRequests: 3, unknownUsageRequests: 3 });
  });

  it('non-retryable errors (auth) are not retried', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('auth', false, { httpStatus: 401 }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 2 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');
    expect(adapter.calls).toHaveLength(1);
    expect(h.repo.getSession(s.id)!.pauseReason).toBe('provider_error');
  });

  it('429 retryAfter is honoured (injected sleep), then the round is played', async () => {
    const adapter = fakeAdapter();
    adapter.script.push(() => failure('rate_limited', true, { retryAfterMs: 1_234, httpStatus: 429 }));
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 1 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.sleeps).toContain(1_234);
    expect(adapter.calls).toHaveLength(2);
    expect(h.repo.listUsage(s.id).map((u) => u.status)).toEqual(['rate_limited', 'ok']);
    expect(h.repo.getSession(s.id)!.roundsPlayed).toBe(1);
  });

  it('persistent 429 pauses with rate_limited', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('rate_limited', true, { retryAfterMs: 90_000 }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 1 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');
    expect(h.repo.getSession(s.id)!.pauseReason).toBe('rate_limited');
    expect(h.sleeps).toContain(30_000); // Retry-After capped at 30 s
    expect(adapter.calls).toHaveLength(2);
  });

  it('invalid output: corrective retries, then paused invalid_output and NO bet placed', async () => {
    const adapter = fakeAdapter();
    adapter.script.push(() => okText('I think red is due!')); // not JSON
    adapter.script.push(() => betDecision([{ type: 'split', numbers: [1, 3], stake: 100 }])); // illegal split
    adapter.script.push(() => betDecision([{ type: 'red', stake: 999_999 }])); // over the limits
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 2 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');

    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[0]!.req.userPrompt).not.toContain('previous reply was rejected');
    expect(adapter.calls[1]!.req.userPrompt).toContain('previous reply was rejected');
    expect(h.repo.getSession(s.id)).toMatchObject({ pauseReason: 'invalid_output', balance: 100_000, roundsPlayed: 0 });
    expect(h.repo.listRounds(s.id)).toHaveLength(0);
    expect(h.outcome.calls).toBe(0);
    const d = h.repo.listDecisions(s.id)[0]!;
    expect(d).toMatchObject({ status: 'invalid', action: null, bets: null, attempts: 3 });
    expect(d.validationErrors.length).toBeGreaterThan(0);
    expect(h.repo.listUsage(s.id).map((u) => u.status)).toEqual(['invalid_output', 'invalid_output', 'invalid_output']);
  });

  it('budget pre-check blocks the call (adapter never invoked) and completes budget_exhausted', async () => {
    const adapter = fakeAdapter({ kind: 'anthropic', paid: true });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { budgetMicros: 1_000 }, { kind: 'anthropic', model: 'claude-sonnet-4-6' });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(adapter.calls).toHaveLength(0);
    const after = h.repo.getSession(s.id)!;
    expect(after.endReason).toBe('budget_exhausted');
    expect(after.message).toMatch(/Budget exhausted: spent \$0\.00 .* could cost up to \$0\.0/);
    expect(h.repo.listDecisions(s.id)[0]).toMatchObject({ status: 'blocked_budget', attempts: 0 });
  });

  it('budget allows a call, then blocks the next one when spent + worst case exceeds it', async () => {
    // Fixture usage: 100 000 input tokens → estimated $0.30 per call at $3/MTok.
    const expensive = okDecision({ action: 'bet', bets: [{ type: 'red', stake: 100 }] }, {
      usage: { inputTokens: 100_000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, known: true },
    });
    const adapter = fakeAdapter({ kind: 'anthropic', paid: true, fallback: () => expensive });
    const pricing = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' as const };
    const h = harness({ adapters: [adapter] });
    // Probe the worst case for this prompt size, then give a budget that fits one call only.
    const probe = createAi(h, { budgetMicros: 1, maxOutputTokens: 400 }, { kind: 'anthropic', model: 'm', pricing });
    await h.service.control(probe.id, 'start', h.key());
    await waitUntil(() => status(h, probe.id) === 'completed', 'probe');
    const worst = Number(/could cost up to \$([0-9.]+)/.exec(h.repo.getSession(probe.id)!.message!)![1]) * 1e6;
    expect(worst).toBeGreaterThan(6_000); // ≥ 400 output tokens × $15/MTok

    const s = createAi(h, { budgetMicros: Math.ceil(worst * 2), maxOutputTokens: 400 }, { kind: 'anthropic', model: 'm', pricing });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(adapter.calls).toHaveLength(1);
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'budget_exhausted', roundsPlayed: 1 });
    const [u] = h.repo.listUsage(s.id);
    expect(u).toMatchObject({ costBasis: 'estimated-from-pricing', costMicros: 100_000 * 3 + 50 * 15 });
    expect(h.repo.getSession(s.id)!.message).toMatch(/spent \$0\.301/);
  });

  it('paid provider with an app limit but no pricing refuses to start; with no app limit it runs', async () => {
    const adapter = fakeAdapter({ kind: 'openai', paid: true });
    const h = harness({ adapters: [adapter] });
    const noPricing = createAi(h, { budgetMicros: 250_000 }, { kind: 'openai', model: 'unpriced-model' });
    await expect(h.service.control(noPricing.id, 'start', h.key())).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(h.service.control(noPricing.id, 'start', h.key())).rejects.toThrow(/No pricing assumption/);
    expect(adapter.calls).toHaveLength(0);
    expect(status(h, noPricing.id)).toBe('ready');
    // No app spending limit (the user's explicit choice): starts even without a pricing assumption.
    const unlimited = createAi(h, { budgetMicros: null, maxRounds: 1 }, { kind: 'openai', model: 'unpriced-model' });
    await h.service.control(unlimited.id, 'start', h.key());
    await waitUntil(() => status(h, unlimited.id) === 'completed', 'completed');
    expect(adapter.calls.length).toBeGreaterThan(0);
  });

  it('an unconfigured provider refuses to start (never switches to the demo player)', async () => {
    const adapter = fakeAdapter({ configured: false });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h);
    await expect(h.service.control(s.id, 'start', h.key())).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(h.repo.listDecisions(s.id)).toHaveLength(0);
  });
});

// ───────────────────────────── limits ─────────────────────────────

describe('limits end autonomous sessions before any further request', () => {
  it('maxRounds → completed max_rounds', async () => {
    const adapter = fakeAdapter();
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 2 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'max_rounds', roundsPlayed: 2 });
    expect(adapter.calls).toHaveLength(2);
  });

  it('maxRuntimeSec → completed max_runtime (injected clock)', async () => {
    let h!: Harness;
    const adapter = fakeAdapter({
      fallback: () => {
        h.clock.advance(40_000); // each decision "takes" 40 s
        return betDecision([{ type: 'red', stake: 100 }]);
      },
    });
    h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRuntimeSec: 60, maxRounds: null });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'max_runtime', roundsPlayed: 2 });
    expect(h.repo.getSession(s.id)!.runtimeMs).toBe(80_000);
    expect(adapter.calls).toHaveLength(2);
  });

  it('balance below minStake → completed insufficient_balance without a request', async () => {
    const adapter = fakeAdapter({ fallback: () => betDecision([{ type: 'straight', numbers: [36], stake: 100 }]) });
    const h = harness({ adapters: [adapter], outcomes: [0, 0, 0] });
    const s = createAi(h, { startingBalance: 200, minStake: 100, stakeIncrement: 100, maxStakePerBet: 100, maxStakePerRound: 100 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'insufficient_balance', balance: 0, roundsPlayed: 2 });
    expect(adapter.calls).toHaveLength(2);
  });
});

// ───────────────────────────── recovery ─────────────────────────────

describe('recover() after a restart (file database fixture)', () => {
  const dir = join(process.cwd(), 'tmp', '9');
  const dbPath = join(dir, `recover-${process.pid}.db`);
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(dbPath + suffix, { force: true });
  });

  it('draws exactly one outcome for a committed round, settles an outcome_recorded round with its stored number, pauses running sessions, makes no provider calls', () => {
    mkdirSync(dir, { recursive: true });
    const at = '2026-09-23T10:00:00.000Z';
    const limits = { ...testLimits() };
    // "Before the crash": build state directly in the database.
    const before = openRepository(dbPath);
    const a = before.createSession({ id: 'sess-a', name: 'a', mode: 'ai', player: { kind: 'ollama', model: 'm' }, limits, createdAt: at });
    const b = before.createSession({ id: 'sess-b', name: 'b', mode: 'demo', player: { kind: 'demo' }, limits, createdAt: at });
    const bets = validateBetSlip([{ type: 'red', stake: 1_000 }], { balance: a.balance, limits });
    const committed = before.commitRound({ id: 'r-a1', sessionId: a.id, source: 'ai', decisionId: null, bets, idempotencyKey: null, committedAt: at });
    const recorded = before.commitRound({ id: 'r-b1', sessionId: b.id, source: 'demo', decisionId: null, bets, idempotencyKey: null, committedAt: at });
    before.recordOutcome(recorded.id, 3, at); // 3 is red
    before.updateSession(a.id, { status: 'running', phase: 'committed' });
    before.updateSession(b.id, { status: 'pause_requested', phase: 'outcome_recorded' });
    before.insertDecision({
      id: 'd-pending', sessionId: a.id, roundNumber: 2, epoch: 0, providerKind: 'ollama', model: 'm', status: 'pending',
      action: null, bets: null, explanation: null, rawOutput: null, validationErrors: [], errorCode: null, errorMessage: null,
      attempts: 1, startedAt: at, completedAt: null, latencyMs: null,
    });
    before.close();

    // "After the restart".
    const repo = openRepository(dbPath);
    const outcome = createFixtureOutcomeSource([36]); // 36 is red
    const adapter = fakeAdapter();
    const adapters = new Map<AiProviderKind, ProviderAdapter>([['ollama', adapter]]);
    const service = createGameService({ config: testConfig(), repo, adapters, outcomeSource: outcome, sleep: async () => {} });
    const result = service.recover();

    expect(result).toEqual({ settledRounds: 2, pausedSessions: 2, interruptedDecisions: 1 });
    expect(outcome.calls).toBe(1); // only the committed round drew an outcome
    const ra = repo.getRound(committed.id)!;
    const rb = repo.getRound(recorded.id)!;
    expect(ra).toMatchObject({ status: 'settled', winningNumber: 36, totalReturned: 2_000 });
    expect(rb).toMatchObject({ status: 'settled', winningNumber: 3, totalReturned: 2_000 }); // stored number kept
    expect(repo.getSession(a.id)).toMatchObject({ status: 'paused', pauseReason: 'server_restart', balance: 101_000, phase: 'settled' });
    expect(repo.getSession(b.id)).toMatchObject({ status: 'paused', pauseReason: 'server_restart' });
    expect(repo.getDecision('d-pending')).toMatchObject({ status: 'interrupted' });
    expect(repo.listUsage(a.id)).toEqual([expect.objectContaining({ decisionId: 'd-pending', attempt: 1, known: false, status: 'error' })]);
    expect(adapter.calls).toHaveLength(0);

    // Running recover again changes nothing (no duplicate settlement, no redraw).
    expect(service.recover()).toEqual({ settledRounds: 0, pausedSessions: 0, interruptedDecisions: 0 });
    expect(outcome.calls).toBe(1);
    expect(repo.listLedger(a.id).filter((e) => e.kind === 'payout')).toHaveLength(1);
    repo.close();
  });
});

function testLimits(): SessionLimits {
  return {
    startingBalance: 100_000,
    minStake: 10,
    stakeIncrement: 10,
    maxStakePerBet: 10_000,
    maxStakePerRound: 20_000,
    maxBetsPerRound: 10,
    maxRounds: 50,
    maxRuntimeSec: 1_800,
    maxOutputTokens: 400,
    budgetMicros: 250_000,
    decisionTimeoutMs: 60_000,
    maxRetries: 2,
    maxConsecutiveFailures: 3,
    historyWindow: 20,
    allowModelStop: false,
  };
}

// ───────────────────────────── exports, providers, events ─────────────────────────────

describe('exports, providers and events', () => {
  it('exports JSON and CSV without secrets', () => {
    const h = harness({ outcomes: [5] });
    const { session } = h.service.createSession({ player: { kind: 'manual' } }, h.key());
    h.service.placeManualRound(session.id, [{ type: 'odd', stake: 100 }], 'k');
    const json = h.service.exportSession(session.id, 'json');
    expect(json.filename).toMatch(new RegExp(`^luck-session-${session.id}-2026-09-23\\.json$`));
    expect(json.contentType).toMatch(/application\/json/);
    const parsed = JSON.parse(json.body);
    expect(parsed.session.id).toBe(session.id);
    expect(parsed.rounds).toHaveLength(1);
    const csv = h.service.exportSession(session.id, 'csv');
    expect(csv.filename.endsWith('.csv')).toBe(true);
    expect(csv.body.split(/\r?\n/)[0]).toContain('round');
    expect(json.body + csv.body).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(() => h.service.exportSession(session.id, 'xml' as never)).toThrow(GameError);
  });

  it('lists every AI provider with capabilities and the last connection test', async () => {
    const adapter = fakeAdapter();
    const h = harness({ adapters: [adapter], config: testConfig({ claudeCli: { enabled: false, useSubscriptionAuth: true } }) });
    const before = h.service.listProviders();
    expect(before.map((p) => p.kind)).toEqual(['ollama', 'anthropic', 'openai', 'claude-cli', 'laya']);
    expect(before[0]).toMatchObject({ kind: 'ollama', configured: true, enabled: true, lastTest: null, defaults: { baseUrl: 'http://127.0.0.1:11434' } });
    expect(before.find((p) => p.kind === 'claude-cli')).toMatchObject({ enabled: false, configured: false });
    const test = await h.service.testProvider('ollama');
    expect(test.ok).toBe(true);
    expect(h.service.listProviders()[0]!.lastTest).toEqual(test);
    expect(await h.service.listModels('ollama')).toEqual(['fixture-model']);
    expect(JSON.stringify(h.service.listProviders())).not.toContain(FAKE_ANTHROPIC_KEY);

    // A present CLI adapter is still disabled when the server switch is off.
    const gated = harness({ adapters: [fakeAdapter({ kind: 'claude-cli', paid: true, reportsCost: true })], config: testConfig({ claudeCli: { enabled: false, useSubscriptionAuth: true } }) });
    const cli = gated.service.listProviders().find((p) => p.kind === 'claude-cli')!;
    expect(cli).toMatchObject({ configured: true, enabled: false });
    expect(cli.issues.join(' ')).toMatch(/CLAUDE_CLI_ENABLED/);
    const s = createAi(gated, {}, { kind: 'claude-cli', model: 'haiku' });
    await expect(gated.service.control(s.id, 'start', gated.key())).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('wires the real default adapters (static checks only, no network)', () => {
    const repo = openRepository(':memory:');
    const service = createGameService({ config: testConfig(), repo });
    const providers = service.listProviders();
    expect(providers.map((p) => [p.kind, p.capabilities.kind])).toEqual([
      ['ollama', 'ollama'],
      ['anthropic', 'anthropic'],
      ['openai', 'openai'],
      ['claude-cli', 'claude-cli'],
      ['laya', 'laya'],
    ]);
    expect(providers.find((p) => p.kind === 'ollama')!.capabilities.paid).toBe(false);
    expect(providers.find((p) => p.kind === 'anthropic')!.capabilities.paid).toBe(true);
    expect(JSON.stringify(providers)).not.toContain(FAKE_ANTHROPIC_KEY);
    repo.close();
  });

  it('emits round (pending then settled), decision, usage, log and snapshot events', async () => {
    const adapter = fakeAdapter();
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 1 });
    const events: ServerEvent[] = [];
    const off = h.service.subscribe(s.id, (e) => events.push(e));
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    off();
    const types = new Set(events.map((e) => e.type));
    for (const t of ['snapshot', 'round', 'decision', 'usage', 'log']) expect(types.has(t as ServerEvent['type'])).toBe(true);
    const rounds = events.filter((e): e is { type: 'round'; round: RoundRecord } => e.type === 'round').map((e) => e.round);
    expect(rounds[0]).toMatchObject({ status: 'committed', winningNumber: null });
    expect(rounds.at(-1)).toMatchObject({ status: 'settled' });
    const last = events.filter((e) => e.type === 'snapshot').at(-1);
    expect(last && last.type === 'snapshot' && last.snapshot.session.status).toBe('completed');
  });

  it('control validates state: manual sessions cannot start; ended sessions cannot restart', async () => {
    const h = harness({ adapters: [fakeAdapter()] });
    const manual = h.service.createSession({ player: { kind: 'manual' } }, h.key()).session;
    await expect(h.service.control(manual.id, 'start', h.key())).rejects.toMatchObject({ code: 'invalid_state' });
    const stopped = await h.service.control(manual.id, 'stop', h.key());
    expect(stopped.session).toMatchObject({ status: 'stopped', endReason: 'user_stop', epoch: 1 });
    const ai = createAi(h);
    await h.service.control(ai.id, 'stop', h.key());
    await expect(h.service.control(ai.id, 'start', h.key())).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(h.service.control('missing', 'start', h.key())).rejects.toMatchObject({ code: 'not_found' });
    expect(outcomeScript(3)).toHaveLength(3);
  });
});

// ───────────────────────────── audit fixes: decisions, failures, limits, masking ─────────────────────────────

describe('decision records (fake adapter fixtures)', () => {
  it('#29: an accepted decision keeps the adapter note — masked and clipped to 300 characters; no note → null', async () => {
    const adapter = fakeAdapter();
    const bet = { action: 'bet' as const, bets: [{ type: 'red' as const, stake: 100 }] };
    adapter.script.push(() => okDecision(bet, { note: `Claude Code conversation c-1, turn 2 (resumed); leaked ${FAKE_ANTHROPIC_KEY}` }));
    adapter.script.push(() => okDecision(bet, { note: 'L'.repeat(1_000) }));
    adapter.script.push(() => okDecision(bet)); // no note
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 3 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    const [d1, d2, d3] = [...h.service.listDecisions(s.id)].reverse();
    expect(d1!.providerNote).toBe('Claude Code conversation c-1, turn 2 (resumed); leaked [redacted]');
    expect(d2!.providerNote).toBe('L'.repeat(MAX_PROVIDER_NOTE_CHARS));
    expect(MAX_PROVIDER_NOTE_CHARS).toBe(300);
    expect(d3!.providerNote).toBeNull();
    // The note travels with the decision everywhere (snapshot, export).
    expect(JSON.parse(h.service.exportSession(s.id, 'json').body).decisions[0].providerNote).toMatch(/turn 2 \(resumed\)/);
  });

  it('#40: <think> reasoning is stripped from the stored raw output and never shown', async () => {
    const adapter = fakeAdapter();
    adapter.script.push(() => okText('<think>private chain of thought: bet red</think>\n{"action":"bet","bets":[{"type":"red","stake":100}]}'));
    adapter.script.push(() => okText('<think>only thinking, the output budget ran out'));
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 0, maxRounds: 5 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused after the reasoning-only reply');
    const [accepted, invalid] = [...h.service.listDecisions(s.id)].reverse();
    expect(accepted).toMatchObject({ status: 'accepted', rawOutput: '{"action":"bet","bets":[{"type":"red","stake":100}]}' });
    expect(invalid).toMatchObject({ status: 'invalid', rawOutput: REASONING_ONLY_OUTPUT });
    const everything = JSON.stringify([h.service.listDecisions(s.id), h.service.getSnapshot(s.id)]) + h.service.exportSession(s.id, 'json').body;
    expect(everything).not.toContain('chain of thought');
    expect(everything).not.toContain('output budget ran out');
    expect(everything).not.toContain('<think>private');
  });

  it('#33: a provider that echoes a registered secret never gets it stored, exported or returned by the API', async () => {
    const SECRET = 'LayaEcho-fixture-9f8e7d6c5b'; // no known key shape: only the registered value can catch it
    registerSecret(SECRET);
    try {
      const adapter = fakeAdapter({ kind: 'laya' });
      // 1st attempt: invalid output that echoes the secret (raw output + retry); 2nd: accepted decision echoing it.
      adapter.script.push(() => okText(`I will not answer in JSON. Your token is ${SECRET}`));
      adapter.fallback = () =>
        okDecision(
          { action: 'bet', bets: [{ type: 'red', stake: 100 }], strategy: `echo ${SECRET}`, explanation: `I was sent ${SECRET.toLowerCase()}` },
          { note: `routing via ${encodeURIComponent(SECRET)}` },
        );
      adapter.listModels = async () => [`model-${SECRET}`, 'plain-model'];
      adapter.testConnection = async () => ({ ok: true, testedAt: '2026-09-23T12:00:00.000Z', latencyMs: 1, message: `hello ${SECRET}` });
      const h = harness({ adapters: [adapter] });
      const s = createAi(h, { maxRounds: 1, maxRetries: 1 }, { kind: 'laya' });
      await h.service.control(s.id, 'start', h.key());
      await waitUntil(() => status(h, s.id) === 'completed', 'completed');

      const models = await h.service.listModels('laya');
      expect(models).toEqual(['model-[redacted]', 'plain-model']);
      const test = await h.service.testProvider('laya');
      expect(test.message).toBe('hello [redacted]');
      const decision = h.service.listDecisions(s.id)[0]!;
      expect(decision.explanation).toBe('Strategy: echo [redacted]\nI was sent [redacted]');
      expect(decision.providerNote).toBe('routing via [redacted]');

      const everything = [
        JSON.stringify(h.service.getSnapshot(s.id)),
        JSON.stringify(h.service.listDecisions(s.id)),
        JSON.stringify(h.service.listLogs(s.id)),
        JSON.stringify(h.service.getUsage(s.id)),
        JSON.stringify(h.service.listRounds(s.id)),
        JSON.stringify(h.service.listProviders()),
        JSON.stringify(h.repo.exportSession(s.id)), // what is stored
        h.service.exportSession(s.id, 'json').body,
        h.service.exportSession(s.id, 'csv').body,
        JSON.stringify(models),
        JSON.stringify(test),
      ].join('\n');
      expect(everything.toLowerCase()).not.toContain(SECRET.toLowerCase());
      expect(everything).not.toContain(encodeURIComponent(SECRET));
      expect(everything).toContain('[redacted]');
      expect(() => JSON.parse(h.service.exportSession(s.id, 'json').body)).not.toThrow();
    } finally {
      clearRegisteredSecrets();
    }
  });

  it('#33 (V3): an echoing provider cannot leak the key via the connection-test model list / version or the usage record model', async () => {
    const SECRET = 'EchoFixtureKey-test-4b3a2c1d0e'; // registered like a key from .env (no known key shape)
    registerSecret(SECRET);
    try {
      const adapter = fakeAdapter();
      adapter.fallback = () =>
        okDecision(
          { action: 'bet', bets: [{ type: 'red', stake: 100 }] },
          {
            modelReported: `fake-model ${SECRET}`,
            rateLimit: {
              source: 'response-headers',
              capturedAt: '2026-09-23T12:00:00.000Z',
              entries: [{ name: `x-ratelimit-${SECRET}`, remaining: 5, status: `allowed ${SECRET}`, resetAt: SECRET }],
            },
          },
        );
      adapter.testConnection = async () => ({
        ok: true,
        testedAt: '2026-09-23T12:00:00.000Z',
        latencyMs: 1,
        message: `hello ${SECRET}`,
        version: `v1 ${SECRET}`,
        models: ['fake-model', `leak-${SECRET}`, `upper-${SECRET.toUpperCase()}`],
      });
      const h = harness({ adapters: [adapter] });
      const s = createAi(h, { maxRounds: 1 });
      const events: ServerEvent[] = [];
      h.service.subscribe(s.id, (e) => events.push(e));
      await h.service.control(s.id, 'start', h.key());
      await waitUntil(() => status(h, s.id) === 'completed', 'completed');

      // POST /api/providers/:kind/test and the lastTest cached for GET /api/providers.
      const test = await h.service.testProvider('ollama');
      expect(test).toMatchObject({
        ok: true,
        message: 'hello [redacted]',
        version: 'v1 [redacted]',
        models: ['fake-model', 'leak-[redacted]', 'upper-[redacted]'],
      });
      expect(h.service.listProviders().find((p) => p.kind === 'ollama')!.lastTest).toEqual(test);

      // GET /api/sessions/:id/usage: the stored record itself is masked (not only the export).
      const [stored] = h.repo.listUsage(s.id);
      expect(stored!.model).toBe('fake-model [redacted]');
      expect(stored!.rateLimit!.entries[0]).toEqual({ name: 'x-ratelimit-[redacted]', remaining: 5, status: 'allowed [redacted]', resetAt: '[redacted]' });
      expect(h.service.getUsage(s.id).records).toEqual([stored]);
      const emitted = events.filter((e) => e.type === 'usage');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ usage: { model: 'fake-model [redacted]' } });

      const everything = [
        JSON.stringify(test),
        JSON.stringify(h.service.listProviders()),
        JSON.stringify(h.repo.listUsage(s.id)),
        JSON.stringify(h.repo.exportSession(s.id)), // what is stored
        JSON.stringify(events),
        JSON.stringify(h.service.getSnapshot(s.id)),
      ].join('\n');
      expect(everything.toLowerCase()).not.toContain(SECRET.toLowerCase());
    } finally {
      clearRegisteredSecrets();
    }
  });
});

describe('consecutive failures (fake adapter fixtures)', () => {
  it('#30/#32: below the limit a failed decision does NOT say "paused", waits the Retry-After, and only the last one pauses', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('rate_limited', true, { retryAfterMs: 12_000, httpStatus: 429 }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 0, maxConsecutiveFailures: 3 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');

    expect(adapter.calls).toHaveLength(3);
    // No retries inside a decision (maxRetries 0): the only waits are the two between decisions.
    expect(h.sleeps.filter((ms) => ms > 0)).toEqual([12_000, 12_000]);
    const failedLogs = h.service.listLogs(s.id).filter((l) => l.type === 'decision_failed');
    expect(failedLogs).toHaveLength(2);
    for (const l of failedLogs) {
      expect(l.message).not.toMatch(/paused|press Start/i);
      expect(l.message).toMatch(/keeps running; next decision in 12 s/);
    }
    // Decisions themselves never claim a pause; the session message does, once it is true.
    for (const d of h.service.listDecisions(s.id)) expect(d.errorMessage).not.toMatch(/paused/i);
    const after = h.repo.getSession(s.id)!;
    expect(after).toMatchObject({ status: 'paused', pauseReason: 'rate_limited' });
    expect(after.message).toMatch(/request failed after 1 attempt \(rate_limited 429\)/);
    expect(after.message!.endsWith(PAUSED_AFTER_FAILURE)).toBe(true);
    expect(h.service.listLogs(s.id).filter((l) => l.type === 'session_paused')).toHaveLength(1);
  });

  it('#32: without a Retry-After the wait between failed decisions is a bounded backoff (1 s, 2 s + jitter)', async () => {
    const adapter = fakeAdapter({ fallback: () => failure('server_error', true, { httpStatus: 503 }) });
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 0, maxConsecutiveFailures: 3 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'paused', 'paused');
    const waits = h.sleeps.filter((ms) => ms > 0);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1_000);
    expect(waits[0]).toBeLessThan(1_250);
    expect(waits[1]).toBeGreaterThanOrEqual(2_000);
    expect(waits[1]).toBeLessThan(2_500);
  });

  it('#30: a usable decision after a failure resets the count; the session keeps playing', async () => {
    const adapter = fakeAdapter();
    adapter.script.push(() => failure('unavailable', true));
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRetries: 0, maxConsecutiveFailures: 2, maxRounds: 2 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => status(h, s.id) === 'completed', 'completed');
    expect(h.repo.getSession(s.id)).toMatchObject({ endReason: 'max_rounds', roundsPlayed: 2 });
    expect(adapter.calls).toHaveLength(3);
    expect(h.service.listLogs(s.id).some((l) => /paused/i.test(l.message))).toBe(false);
  });
});

describe('limits are checked before pausing (fixtures)', () => {
  it('#37: Next round (step) on the last allowed round completes the session instead of pausing', async () => {
    const h = harness();
    const s = h.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 1 } }, h.key()).session;
    await h.service.control(s.id, 'step', h.key());
    await waitUntil(() => status(h, s.id) !== 'running', 'step finished');
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'completed', endReason: 'max_rounds', pauseReason: null, roundsPlayed: 1 });
    // A step that leaves rounds to play still pauses (step_complete).
    const more = h.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 3 } }, h.key()).session;
    await h.service.control(more.id, 'step', h.key());
    await waitUntil(() => status(h, more.id) !== 'running', 'step finished');
    expect(h.repo.getSession(more.id)).toMatchObject({ status: 'paused', pauseReason: 'step_complete', roundsPlayed: 1 });
  });

  it('#37: Pause after round when the balance can no longer cover the minimum stake completes the session', async () => {
    const adapter = fakeAdapter();
    const d = deferred<ProviderCallResult>();
    adapter.script.push(() => d.promise);
    const h = harness({ adapters: [adapter], outcomes: [0] });
    const s = createAi(h, { startingBalance: 100, minStake: 100, stakeIncrement: 100 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'first call');
    expect((await h.service.control(s.id, 'pause', h.key())).session.status).toBe('pause_requested');
    d.resolve(betDecision([{ type: 'red', stake: 100 }])); // 0 wins: the whole balance is lost
    await waitUntil(() => status(h, s.id) !== 'pause_requested', 'round finished');
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'completed', endReason: 'insufficient_balance', pauseReason: null, balance: 0 });
    expect(adapter.calls).toHaveLength(1);
  });

  it('#37: Pause after the round that reaches maxRounds completes the session', async () => {
    const adapter = fakeAdapter();
    const d = deferred<ProviderCallResult>();
    adapter.script.push(() => d.promise);
    const h = harness({ adapters: [adapter] });
    const s = createAi(h, { maxRounds: 1 });
    await h.service.control(s.id, 'start', h.key());
    await waitUntil(() => adapter.calls.length === 1, 'first call');
    await h.service.control(s.id, 'pause', h.key());
    d.resolve(betDecision([{ type: 'red', stake: 100 }]));
    await waitUntil(() => status(h, s.id) !== 'pause_requested', 'round finished');
    expect(h.repo.getSession(s.id)).toMatchObject({ status: 'completed', endReason: 'max_rounds' });
  });
});

describe('input validation', () => {
  it('#31: an invalid Claude Code CLI model is refused at session creation and in settings (validation_error)', () => {
    const h = harness();
    for (const model of ['--tools=Bash', '-x', '.hidden']) {
      expect(() => h.service.createSession({ player: { kind: 'claude-cli', model } }, h.key())).toThrow(
        expect.objectContaining({ code: 'validation_error', message: expect.stringMatching(/Claude Code CLI model/) }),
      );
      expect(() => h.service.updateSettings({ players: { 'claude-cli': { kind: 'claude-cli', model } } })).toThrow(
        expect.objectContaining({ code: 'validation_error' }),
      );
    }
    expect(h.service.listSessions()).toHaveLength(0);
    expect(h.service.getSettings().players['claude-cli']).toBeUndefined();
    // Aliases and model ids are accepted; other providers keep their own (looser) rules.
    expect(h.service.createSession({ player: { kind: 'claude-cli', model: 'haiku' } }, h.key()).session.player.model).toBe('haiku');
    expect(h.service.updateSettings({ players: { 'claude-cli': { kind: 'claude-cli', model: 'claude-sonnet-4-6[1m]' } } }).players['claude-cli']!.model).toBe(
      'claude-sonnet-4-6[1m]',
    );
    expect(h.service.createSession({ player: { kind: 'ollama', model: '-weird:tag' } }, h.key()).session.player.model).toBe('-weird:tag');
  });

  it('a create-session request with a partial "limits" object keeps the saved defaults it omits (allowModelStop stays true)', () => {
    const h = harness();
    h.service.updateSettings({ defaultLimits: { ...DEFAULT_LIMITS, allowModelStop: true, maxConsecutiveFailures: 3 } });
    const s = h.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 1 } }, h.key()).session;
    expect(s.limits).toMatchObject({ allowModelStop: true, maxConsecutiveFailures: 3, maxRounds: 1 });
    // Sent explicitly, the request still wins.
    const off = h.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 1, allowModelStop: false } }, h.key()).session;
    expect(off.limits.allowModelStop).toBe(false);
    // Without any saved default, an omitted allowModelStop is false (DEFAULT_LIMITS).
    const fresh = harness();
    expect(fresh.service.createSession({ player: { kind: 'demo' }, limits: { maxRounds: 1 } }, fresh.key()).session.limits.allowModelStop).toBe(false);
  });
});
