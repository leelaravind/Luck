/**
 * E2E — autonomous AI sessions driven by FIXTURE provider adapters (scripted test doubles, no network).
 *
 * Nothing here talks to a real model. These suites prove the SESSION RUNNER's contract with any adapter:
 * valid decisions become settled rounds; Stop during a slow decision aborts it and a late answer is
 * discarded; provider failures pause after bounded retries (and never fall back to the demo player);
 * the app budget blocks paid requests; invalid output never becomes a bet; and the observation handed
 * to the adapter is exactly a GameObservation without the pending outcome or internal ids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DecisionRecord,
  GameObservation,
  RoundRecord,
  SessionSnapshot,
  UsageRecord,
  UsageSummary,
} from '../../src/shared/contracts.js';
import {
  FAKE_SECRET,
  FixtureAdapter,
  control,
  countingFixtureOutcomes,
  createHarness,
  createSession,
  delay,
  expectOk,
  fixtureDecision,
  fixtureError,
  fixtureText,
  gate,
  keyPaths,
  snapshot,
  waitFor,
  waitForStatus,
  type Harness,
} from './harness.js';

const START = 100_000;
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    for (const r of h.transcript) expect(r.body.includes(FAKE_SECRET), `${r.method} ${r.url}`).toBe(false);
    await h.close({ removeDb: true });
  }
});
async function harness(opts: Parameters<typeof createHarness>[0]) {
  const h = await createHarness(opts);
  open.push(h);
  return h;
}

const rounds = async (h: Harness, id: string) =>
  expectOk(await h.api<{ rounds: RoundRecord[] }>('GET', `/api/sessions/${id}/rounds?limit=100`), 'rounds').rounds;
const decisions = async (h: Harness, id: string) =>
  expectOk(await h.api<{ decisions: DecisionRecord[] }>('GET', `/api/sessions/${id}/decisions?limit=100`), 'decisions')
    .decisions;
const usage = async (h: Harness, id: string) =>
  expectOk(await h.api<{ records: UsageRecord[]; summary: UsageSummary }>('GET', `/api/sessions/${id}/usage`), 'usage');

const LOCAL_PLAYER = { kind: 'ollama', model: 'fixture-model-1' };

describe('E2E AI session with a FIXTURE adapter', () => {
  it('FIXTURE adapter: valid decisions (bet / skip / bet / bet) become exactly the scripted settled rounds', async () => {
    // Semantics (documented in src/server/session/runner.ts): one decision per round; "skip" sits the
    // round out, i.e. the wheel still spins a NO-BET round that counts toward maxRounds.
    const outcomes = countingFixtureOutcomes([17, 3, 3, 20]);
    const script = [
      { action: 'bet', bets: [{ type: 'straight', numbers: [17], stake: 100 }], explanation: 'fixture: straight 17' },
      { action: 'skip', explanation: 'fixture: sit out' },
      { action: 'bet', bets: [{ type: 'split', numbers: [0, 3], stake: 50 }] },
      { action: 'bet', bets: [{ type: 'red', stake: 200 }] },
    ];
    const adapter = new FixtureAdapter({
      kind: 'ollama',
      outcomes,
      respond: (_c, i) => fixtureDecision(script[Math.min(i, script.length - 1)]),
    });
    const h = await harness({ label: 'ai-valid', outcomes, adapters: [adapter] });
    const { session } = await createSession(h, { player: LOCAL_PLAYER, limits: { maxRounds: 4 } });
    expect(session.mode).toBe('ai');
    expect(adapter.calls).toHaveLength(0); // creating a session never calls the provider

    expectOk(await control(h, session.id, 'start'), 'start');
    const done = await waitForStatus(h, session.id, ['completed', 'paused', 'stopped']);
    expect(done.session.status).toBe('completed');
    expect(done.session.endReason).toBe('max_rounds');

    const rs = (await rounds(h, session.id)).sort((a, b) => a.seq - b.seq);
    expect(rs.map((r) => r.winningNumber)).toEqual([17, 3, 3, 20]);
    // straight 17 wins 35×100; skip round has no stake; split 0/3 wins 17×50 on 3; red loses on 20 (black)
    expect(rs.map((r) => r.net)).toEqual([3500, 0, 850, -200]);
    expect(rs.map((r) => r.totalStake)).toEqual([100, 0, 50, 200]);
    expect(rs[1]!.bets).toEqual([]);
    expect(rs.every((r) => r.source === 'ai' && r.status === 'settled' && r.decisionId)).toBe(true);
    expect(done.session.balance).toBe(START + 3500 + 850 - 200);

    const ds = await decisions(h, session.id);
    expect(adapter.calls).toHaveLength(4); // exactly one model call per round
    expect(ds).toHaveLength(4);
    expect(ds.every((d) => d.status === 'accepted' && d.providerKind === 'ollama')).toBe(true);
    for (const r of rs) {
      const d = ds.find((x) => x.id === r.decisionId)!;
      expect(d.roundNumber).toBe(r.seq);
      expect(d.action).toBe(r.seq === 2 ? 'skip' : 'bet');
    }
    expect(ds.find((d) => d.roundNumber === 1)!.explanation).toBe('fixture: straight 17');
    // usage is recorded per attempt, local inference → no cloud charge
    const u = await usage(h, session.id);
    expect(u.records).toHaveLength(4);
    expect(u.records.every((x) => x.costBasis === 'local-no-charge' && x.status === 'ok')).toBe(true);
    expect(u.summary.requests).toBe(4);
    expect(u.summary.inputTokens).toBe(4 * 120);
    expect(u.summary.outputTokens).toBe(4 * 30);
    expect(u.summary.costMicros).toBe(0);
  });

  it('FIXTURE slow adapter: Stop during a decision aborts it; the late valid answer is discarded (stale/cancelled)', async () => {
    const g = gate();
    const adapter = new FixtureAdapter({
      kind: 'ollama',
      // Deliberately ignores the AbortSignal and answers late with a perfectly valid bet.
      respond: async () => {
        await g.promise;
        return fixtureDecision({ action: 'bet', bets: [{ type: 'red', stake: 500 }] });
      },
    });
    const h = await harness({ label: 'ai-stop', outcomes: [1, 1, 1], adapters: [adapter] });
    const { session } = await createSession(h, { player: LOCAL_PLAYER, limits: { maxRounds: 5 } });
    expectOk(await control(h, session.id, 'start'), 'start');
    await waitFor(() => adapter.calls.length === 1, 'decision request in flight');
    const inFlight = await snapshot(h, session.id);
    expect(inFlight.inFlight.decision).toBe(true);
    expect(inFlight.session.phase).toBe('requesting_decision');

    const stopP = control(h, session.id, 'stop'); // not awaited: Stop must not depend on the provider answering
    await waitFor(() => adapter.calls[0]!.signal.aborted, 'AbortSignal of the in-flight request', 5_000);
    g.release(); // the provider "answers" after Stop
    const stopRes = await stopP;
    expect(stopRes.status).toBeLessThan(300);
    const stopped = await waitForStatus(h, session.id, ['stopped']);
    expect(stopped.session.endReason).toBe('user_stop');
    await delay(150);

    expect(await rounds(h, session.id)).toHaveLength(0);
    const after = await snapshot(h, session.id);
    expect(after.session.balance).toBe(START);
    expect(h.outcomes.calls).toBe(0);
    const ds = await decisions(h, session.id);
    expect(ds).toHaveLength(1);
    expect(['stale', 'cancelled']).toContain(ds[0]!.status);
    expect(adapter.calls).toHaveLength(1); // no retry after Stop
    expect(after.session.epoch).toBeGreaterThan(session.epoch); // Stop bumps the epoch
  });

  it('FIXTURE failing adapter: bounded retries (1 + maxRetries attempts), then paused — no demo fallback', async () => {
    const adapter = new FixtureAdapter({
      kind: 'ollama',
      respond: () => fixtureError('server_error', 'FIXTURE: upstream 500'),
    });
    const h = await harness({ label: 'ai-fail', outcomes: [1, 2, 3], adapters: [adapter] });
    const { session } = await createSession(h, {
      player: LOCAL_PLAYER,
      limits: { maxRounds: 5, maxRetries: 2, maxConsecutiveFailures: 1 },
    });
    expectOk(await control(h, session.id, 'start'), 'start');
    const paused = await waitForStatus(h, session.id, ['paused', 'stopped', 'completed'], 15_000);
    expect(paused.session.status).toBe('paused');
    expect(paused.session.pauseReason).toBe('provider_error');
    expect(paused.session.message ?? '').not.toBe('');
    expect(adapter.calls).toHaveLength(3);
    await delay(200);
    expect(adapter.calls).toHaveLength(3); // no background retries while paused

    const ds = await decisions(h, session.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'server_error', providerKind: 'ollama' });
    expect(ds.every((d) => d.providerKind === 'ollama')).toBe(true); // never switched to the demo player
    expect(await rounds(h, session.id)).toHaveLength(0);
    expect((await snapshot(h, session.id)).session.balance).toBe(START);
    const u = await usage(h, session.id);
    expect(u.records).toHaveLength(3); // failed attempts are counted
    expect(u.records.every((r) => r.status === 'error')).toBe(true);
    expect(u.summary.failedRequests).toBe(3);
    expect(u.summary.unknownUsageRequests).toBe(3); // the fixture reports usage as unknown on errors
  });

  it('FIXTURE failing adapter: limits.maxConsecutiveFailures (contract) — pause only after N failed decisions', async () => {
    // SessionLimits.maxConsecutiveFailures: "Consecutive failed decisions before the session pauses."
    // With maxRetries 2 and maxConsecutiveFailures 2 the contract implies 2 decisions × 3 attempts = 6 calls.
    const adapter = new FixtureAdapter({
      kind: 'ollama',
      respond: () => fixtureError('server_error', 'FIXTURE: upstream 500'),
    });
    const h = await harness({ label: 'ai-fail2', outcomes: [1, 2, 3], adapters: [adapter] });
    const { session } = await createSession(h, {
      player: LOCAL_PLAYER,
      limits: { maxRounds: 5, maxRetries: 2, maxConsecutiveFailures: 2 },
    });
    expectOk(await control(h, session.id, 'start'), 'start');
    const paused = await waitForStatus(h, session.id, ['paused', 'stopped', 'completed'], 15_000);
    expect(paused.session.pauseReason).toBe('provider_error');
    const ds = await decisions(h, session.id);
    expect(ds.map((d) => d.status)).toEqual(['failed', 'failed']);
    expect(adapter.calls).toHaveLength(6);
    expect(await rounds(h, session.id)).toHaveLength(0);
  });

  describe('FIXTURE adapter returning invalid output: never becomes a bet', () => {
    const invalid: [string, string][] = [
      ['prose instead of JSON', 'I have a good feeling about red tonight.'],
      ['unknown action', JSON.stringify({ action: 'double_down', bets: [] })],
      ['illegal split 1/5', JSON.stringify({ action: 'bet', bets: [{ type: 'split', numbers: [1, 5], stake: 100 }] })],
      ['fractional stake', JSON.stringify({ action: 'bet', bets: [{ type: 'red', stake: 12.5 }] })],
      ['stake above the balance', JSON.stringify({ action: 'bet', bets: [{ type: 'red', stake: 90_000_000 }] })],
      ['unknown field', JSON.stringify({ action: 'bet', bets: [{ type: 'red', stake: 100, multiplier: 10 }] })],
      ['two JSON objects', '{"action":"skip"} {"action":"bet","bets":[{"type":"red","stake":100}]}'],
    ];
    for (const [name, text] of invalid) {
      it(`FIXTURE: ${name}`, async () => {
        const adapter = new FixtureAdapter({ kind: 'ollama', respond: () => fixtureText(text) });
        const h = await harness({ label: 'ai-invalid', outcomes: [1, 2, 3], adapters: [adapter] });
        const { session } = await createSession(h, {
          player: LOCAL_PLAYER,
          limits: { maxRounds: 3, maxRetries: 1, maxConsecutiveFailures: 1 },
        });
        expectOk(await control(h, session.id, 'start'), 'start');
        const s = await waitForStatus(h, session.id, ['paused', 'stopped', 'completed']);
        expect(s.session.status).toBe('paused');
        expect(s.session.pauseReason).toBe('invalid_output');
        expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
        expect(adapter.calls.length).toBeLessThanOrEqual(2); // 1 attempt + maxRetries 1
        expect(await rounds(h, session.id)).toHaveLength(0);
        expect(s.session.balance).toBe(START);
        expect(h.outcomes.calls).toBe(0);
        const ds = await decisions(h, session.id);
        expect(ds).toHaveLength(1);
        expect(ds[0]!.status).toBe('invalid');
        expect(ds[0]!.validationErrors.length).toBeGreaterThan(0);
        expect(ds[0]!.rawOutput).toContain(text.slice(0, 20)); // raw output kept for inspection
      });
    }
  });

  it('FIXTURE paid adapter: a budget that cannot cover one request blocks it (adapter never called)', async () => {
    const adapter = new FixtureAdapter({
      kind: 'anthropic',
      paid: true,
      respond: () => fixtureDecision({ action: 'bet', bets: [{ type: 'red', stake: 100 }] }),
    });
    const h = await harness({ label: 'ai-budget0', outcomes: [1, 2], adapters: [adapter] });
    const created = await h.api<SessionSnapshot>('POST', '/api/sessions', {
      body: {
        player: {
          kind: 'anthropic',
          model: 'fixture-model-1',
          pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' },
        },
        limits: { maxRounds: 3, budgetMicros: 1 },
      },
    });
    const { session } = expectOk(created, 'create paid session');
    const start = await control(h, session.id, 'start');
    if (start.status >= 300) {
      // Refused up front is acceptable (402 budget_exhausted) …
      expect(start.status).toBe(402);
    } else {
      // … or started and ended immediately for budget reasons.
      const s = await waitForStatus(h, session.id, ['completed', 'paused', 'stopped']);
      expect(s.session.endReason).toBe('budget_exhausted');
    }
    await delay(100);
    expect(adapter.calls).toHaveLength(0);
    expect(await rounds(h, session.id)).toHaveLength(0);
    const u = await usage(h, session.id);
    expect(u.summary.costMicros).toBe(0);
  });

  it('FIXTURE paid adapter: spending stops before the budget is exceeded; blocked requests are never sent', async () => {
    // Each fixture answer reports 1000 input + 400 output tokens → at $3 / $15 per MTok that is
    // 3000 + 6000 = 9000 µUSD per call. Budget 30 000 µUSD. A conservative pre-request check must assume
    // the output cap (400 tokens = 6000 µUSD), so the 4th call can never be afforded (27 000 spent).
    const heavy = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, known: true };
    const adapter = new FixtureAdapter({
      kind: 'anthropic',
      paid: true,
      respond: () => fixtureDecision({ action: 'bet', bets: [{ type: 'black', stake: 100 }] }, heavy),
    });
    const h = await harness({ label: 'ai-budget', outcomes: Array.from({ length: 20 }, () => 1), adapters: [adapter] });
    const { session } = await createSession(h, {
      player: {
        kind: 'anthropic',
        model: 'fixture-model-1',
        pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' },
      },
      limits: { maxRounds: 10, budgetMicros: 30_000, maxOutputTokens: 400 },
    });
    expectOk(await control(h, session.id, 'start'), 'start');
    const s = await waitForStatus(h, session.id, ['completed', 'paused', 'stopped']);
    expect(s.session.status).toBe('completed');
    expect(s.session.endReason).toBe('budget_exhausted');
    const calls = adapter.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
    await delay(150);
    expect(adapter.calls).toHaveLength(calls);

    const u = await usage(h, session.id);
    expect(u.records.filter((r) => r.status === 'ok')).toHaveLength(calls);
    expect(u.summary.costMicros).toBe(calls * 9000);
    expect(u.summary.costMicros).toBeLessThanOrEqual(30_000);
    expect(u.summary.budgetMicros).toBe(30_000);
    expect(u.summary.budgetRemainingMicros).toBe(30_000 - calls * 9000);
    expect(u.records.every((r) => r.costBasis === 'estimated-from-pricing')).toBe(true);
    expect(await rounds(h, session.id)).toHaveLength(calls);
    // Every decision that was not sent is marked blocked_budget, not failed/accepted.
    const ds = await decisions(h, session.id);
    expect(ds.filter((d) => d.status === 'accepted')).toHaveLength(calls);
    for (const d of ds.filter((x) => x.status !== 'accepted')) expect(d.status).toBe('blocked_budget');
  });

  it('FIXTURE recording adapter: the observation is a GameObservation built only from settled history', async () => {
    const outcomes = countingFixtureOutcomes([32, 15, 19, 4, 21]);
    const adapter = new FixtureAdapter({
      kind: 'ollama',
      outcomes,
      respond: (_c, i) =>
        fixtureDecision({ action: 'bet', bets: [{ type: i % 2 ? 'odd' : 'even', stake: 100 }, { type: 'straight', numbers: [i], stake: 10 }] }),
    });
    const h = await harness({ label: 'ai-observe', outcomes, adapters: [adapter] });
    const { session } = await createSession(h, { player: LOCAL_PLAYER, limits: { maxRounds: 4, historyWindow: 2 } });
    expectOk(await control(h, session.id, 'start'), 'start');
    const done = await waitForStatus(h, session.id, ['completed', 'paused', 'stopped']);
    expect(done.session.status).toBe('completed');
    const settled = (await rounds(h, session.id)).sort((a, b) => a.seq - b.seq);
    expect(settled).toHaveLength(4);

    const TOP = ['schemaVersion', 'game', 'roundNumber', 'balance', 'units', 'limits', 'betTypes', 'rules', 'history', 'stats'];
    const LIMITS = ['minStake', 'stakeIncrement', 'maxStakePerBet', 'maxStakePerRound', 'maxBetsPerRound', 'roundsRemaining'];
    const HISTORY = ['round', 'winningNumber', 'color', 'yourBets', 'yourTotalStake', 'yourNet'];
    const YOURBET = ['type', 'numbers', 'index', 'stake'];
    const allowedPaths = new Set<string>([
      ...TOP,
      ...LIMITS.map((k) => `limits.${k}`),
      ...['type', 'payout', 'selection'].map((k) => `betTypes[].${k}`),
      ...HISTORY.map((k) => `history[].${k}`),
      ...YOURBET.map((k) => `history[].yourBets[].${k}`),
      'stats.roundsPlayed',
      'stats.netResult',
    ]);
    const internalIds = [session.id, ...settled.map((r) => r.id), ...settled.map((r) => r.decisionId!)];

    expect(adapter.calls).toHaveLength(4);
    for (const [i, call] of adapter.calls.entries()) {
      const obs = call.req.observation as GameObservation;
      const roundNumber = i + 1;
      // 1) only contract keys, recursively
      const extra = keyPaths(obs).filter((p) => !allowedPaths.has(p));
      expect(extra, `unexpected observation keys for round ${roundNumber}`).toEqual([]);
      expect(obs.schemaVersion).toBe(1);
      expect(obs.game).toBe('european-roulette-single-zero');
      expect(obs.roundNumber).toBe(roundNumber);
      // 2) the pending round's outcome did not exist yet when the model was asked
      expect(call.drawsAtCall).toBe(roundNumber - 1);
      expect(obs.history.every((hr) => hr.round < roundNumber)).toBe(true);
      // 3) history is the settled past, bounded by historyWindow, and matches the ledger
      expect(obs.history.length).toBe(Math.min(roundNumber - 1, 2));
      for (const hr of obs.history) {
        const r = settled.find((x) => x.seq === hr.round)!;
        expect(hr.winningNumber).toBe(r.winningNumber);
        expect(hr.yourNet).toBe(r.net);
        expect(hr.yourTotalStake).toBe(r.totalStake);
      }
      const prior = settled.filter((r) => r.seq < roundNumber);
      expect(obs.balance).toBe(prior.length ? prior[prior.length - 1]!.balanceAfter : START);
      expect(obs.stats.roundsPlayed).toBe(prior.length);
      expect(obs.stats.netResult).toBe(prior.reduce((s, r) => s + r.net!, 0));
      expect(obs.limits.roundsRemaining).not.toBeNull();
      expect(obs.limits.roundsRemaining!).toBeLessThanOrEqual(4 - prior.length);
      expect(obs.limits.roundsRemaining!).toBeGreaterThanOrEqual(0);
      // 4) prompts carry no internal ids, secrets or RNG details; the future outcome is not in the prompt history
      const everything = JSON.stringify(obs) + call.req.userPrompt + call.req.systemPrompt;
      for (const idv of internalIds) expect(everything.includes(idv), `internal id ${idv} leaked`).toBe(false);
      expect(everything.includes(FAKE_SECRET)).toBe(false);
      expect(everything).not.toMatch(/\b(rngState|nextOutcome|pendingOutcome|dbPath|sessionId|roundId|decisionId)\b/);
      // 5) budget/config secrets are not part of the request (adapters get secrets only via cfg)
      expect(call.req.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('FIXTURE adapter: no provider call happens without an explicit Start (P10)', async () => {
    const adapter = new FixtureAdapter({ kind: 'ollama', respond: () => fixtureDecision({ action: 'skip' }) });
    const h = await harness({ label: 'ai-idle', outcomes: [1], adapters: [adapter] });
    const { session } = await createSession(h, { player: LOCAL_PLAYER, limits: { maxRounds: 2 } });
    await delay(200);
    expect(adapter.calls).toHaveLength(0);
    expect((await snapshot(h, session.id)).session.status).toBe('ready');
  });
});
