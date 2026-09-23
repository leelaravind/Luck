/**
 * E2E — crash / restart recovery on a real SQLite FILE database (tmp/10/db, gitignored).
 *
 * Crash states are written straight through the Repository (as if the process died mid-round), then a
 * NEW repository + service + app are opened on the same file and recover() is called. Proves (D3, G7, P10):
 *   - a committed round without an outcome is drawn once and settled once,
 *   - a round whose outcome was already stored is settled with THAT number (never redrawn),
 *   - running sessions come back paused with pauseReason server_restart,
 *   - a pending provider decision is marked interrupted and the adapter is never called,
 *   - a second restart changes nothing.
 * The FIXTURE outcome source is call-counted; the FIXTURE adapter counts calls.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  type DecisionRecord,
  type PlayerConfig,
  type ResolvedBet,
  type RoundRecord,
  type SessionMode,
} from '../../src/shared/contracts.js';
import { RED_NUMBERS } from '../../src/shared/roulette.js';
import type { SessionExport } from '../../src/server/types.js';
import { openRepository } from '../../src/server/db/sqlite.js';
import {
  FAKE_SECRET,
  FixtureAdapter,
  control,
  countingFixtureOutcomes,
  createHarness,
  delay,
  expectOk,
  fixtureDecision,
  ledgerSum,
  removeDbFiles,
  snapshot,
  tmpDbPath,
  waitForStatus,
  type Harness,
} from './harness.js';

const START = DEFAULT_LIMITS.startingBalance; // 100_000
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Resolved bets written directly to the DB (canonical keys as documented in contracts.ts).
const STRAIGHT_17: ResolvedBet = { key: 'straight:17', type: 'straight', numbers: [17], stake: 100, payout: 35, label: 'Straight 17' };
const RED_200: ResolvedBet = { key: 'red', type: 'red', numbers: [...RED_NUMBERS].sort((a, b) => a - b), stake: 200, payout: 1, label: 'Red' };
const RED_500: ResolvedBet = { ...RED_200, stake: 500 };
const DOZEN3_100: ResolvedBet = { key: 'dozen:3', type: 'dozen', numbers: range(25, 36), index: 3, stake: 100, payout: 2, label: '3rd Dozen' };
const SPLIT03_100: ResolvedBet = { key: 'split:0-3', type: 'split', numbers: [0, 3], stake: 100, payout: 17, label: 'Split 0/3' };

describe('E2E restart recovery (file DB, FIXTURE outcome source + FIXTURE adapter)', () => {
  const dbPath = tmpDbPath('restart');
  const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID() };
  const roundIds = { A: randomUUID(), B: randomUUID(), D: randomUUID() };
  const decisionId = randomUUID();
  let h1: Harness | undefined;
  let h2: Harness | undefined;

  afterAll(async () => {
    for (const h of [h1, h2]) {
      for (const r of h?.transcript ?? []) expect(r.body.includes(FAKE_SECRET)).toBe(false);
      await h?.close();
    }
    removeDbFiles(dbPath);
  });

  it('writes four crash states through the Repository', () => {
    const repo = openRepository(dbPath);
    const now = () => new Date().toISOString();
    const mk = (id: string, mode: SessionMode, player: PlayerConfig, limits = DEFAULT_LIMITS) =>
      repo.createSession({ id, name: `crash-${mode}`, mode, player, limits, createdAt: now() });

    // A: manual — bets committed, process died before the outcome was drawn.
    mk(ids.A, 'manual', { kind: 'manual' });
    repo.commitRound({ id: roundIds.A, sessionId: ids.A, source: 'manual', decisionId: null, bets: [STRAIGHT_17, RED_200], idempotencyKey: 'crash-a', committedAt: now() });

    // B: manual — outcome 32 recorded, process died before settlement.
    mk(ids.B, 'manual', { kind: 'manual' });
    repo.commitRound({ id: roundIds.B, sessionId: ids.B, source: 'manual', decisionId: null, bets: [RED_500, DOZEN3_100], idempotencyKey: 'crash-b', committedAt: now() });
    repo.recordOutcome(roundIds.B, 32, now());

    // C: AI session 'running' with a provider request in flight.
    const c = mk(ids.C, 'ai', { kind: 'anthropic', model: 'fixture-model-1' });
    repo.updateSession(ids.C, { status: 'running', phase: 'requesting_decision' });
    const pending: DecisionRecord = {
      id: decisionId,
      sessionId: ids.C,
      roundNumber: 1,
      epoch: c.epoch,
      providerKind: 'anthropic',
      model: 'fixture-model-1',
      status: 'pending',
      action: null,
      bets: null,
      explanation: null,
      rawOutput: null,
      validationErrors: [],
      errorCode: null,
      errorMessage: null,
      attempts: 1,
      startedAt: now(),
      completedAt: null,
      latencyMs: null,
    };
    repo.insertDecision(pending);

    // D: demo session 'running', outcome 0 recorded for its round, not settled.
    mk(ids.D, 'demo', { kind: 'demo' }, { ...DEFAULT_LIMITS, maxRounds: 2 });
    repo.updateSession(ids.D, { status: 'running', phase: 'outcome_recorded' });
    repo.commitRound({ id: roundIds.D, sessionId: ids.D, source: 'demo', decisionId: null, bets: [SPLIT03_100], idempotencyKey: null, committedAt: now() });
    repo.recordOutcome(roundIds.D, 0, now());

    // Sanity: the crash state is what we intended.
    expect(repo.findUnsettledRounds().map((r) => r.id).sort()).toEqual([roundIds.A, roundIds.B, roundIds.D].sort());
    expect(repo.findPendingDecisions().map((d) => d.id)).toEqual([decisionId]);
    expect(repo.getSession(ids.A)!.balance).toBe(START - 300);
    expect(repo.getSession(ids.B)!.balance).toBe(START - 600);
    expect(repo.getSession(ids.D)!.balance).toBe(START - 100);
    repo.close();
  });

  const adapter1 = new FixtureAdapter({
    kind: 'anthropic',
    paid: true,
    respond: () => fixtureDecision({ action: 'bet', bets: [{ type: 'red', stake: 100 }] }),
  });

  it('first restart: recover() settles each round once, never redraws, pauses, interrupts, calls no provider', async () => {
    // If round B or D were (wrongly) redrawn they would get 5 (red, 1st dozen) and settle differently.
    const outcomes = countingFixtureOutcomes([17, 5, 5, 5, 5]);
    h1 = await createHarness({ label: 'restart-1', dbPath, outcomes, adapters: [adapter1] });
    const result = h1.service.recover();
    expect(result).toEqual({ settledRounds: 3, pausedSessions: 2, interruptedDecisions: 1 });
    expect(outcomes.calls).toBe(1); // only round A had no stored outcome

    const round = async (sid: string) => expectOk(await h1!.api<{ rounds: RoundRecord[] }>('GET', `/api/sessions/${sid}/rounds`), 'rounds').rounds;

    // A: drawn 17 → straight 17 wins 100 + 3500, red loses. Returned 3600.
    const [ra] = await round(ids.A);
    expect(ra).toMatchObject({ id: roundIds.A, status: 'settled', winningNumber: 17, totalStake: 300, stakeReturned: 100, winnings: 3500, totalReturned: 3600, net: 3300 });
    expect((await snapshot(h1, ids.A)).session.balance).toBe(START + 3300);

    // B: stored 32 (red, 3rd dozen) → red 500+500, dozen 100+200. Returned 1300.
    const [rb] = await round(ids.B);
    expect(rb).toMatchObject({ id: roundIds.B, status: 'settled', winningNumber: 32, totalStake: 600, stakeReturned: 600, winnings: 700, totalReturned: 1300, net: 700 });
    expect((await snapshot(h1, ids.B)).session.balance).toBe(START + 700);

    // D: stored 0 → split 0/3 wins 100 + 1700.
    const [rd] = await round(ids.D);
    expect(rd).toMatchObject({ id: roundIds.D, status: 'settled', winningNumber: 0, totalReturned: 1800, net: 1700 });

    // Sessions: running ones paused with server_restart; manual ones are not running.
    const c = await snapshot(h1, ids.C);
    expect(c.session.status).toBe('paused');
    expect(c.session.pauseReason).toBe('server_restart');
    expect(c.inFlight.decision).toBe(false);
    const d = await snapshot(h1, ids.D);
    expect(d.session.status).toBe('paused');
    expect(d.session.pauseReason).toBe('server_restart');
    expect(d.session.balance).toBe(START + 1700);
    expect(d.session.roundsPlayed).toBe(1);
    for (const sid of [ids.A, ids.B]) expect((await snapshot(h1, sid)).session.status).not.toBe('running');

    // The pending decision is interrupted, not retried.
    const { decisions } = expectOk(await h1.api<{ decisions: DecisionRecord[] }>('GET', `/api/sessions/${ids.C}/decisions`), 'decisions');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ id: decisionId, status: 'interrupted' });
    expect(decisions[0]!.completedAt).toBeTruthy();

    // No paid call is auto-resumed after restart (P10).
    await delay(250);
    expect(adapter1.calls).toHaveLength(0);
    expect((await snapshot(h1, ids.C)).session.status).toBe('paused');
    expect((await snapshot(h1, ids.D)).session.roundsPlayed).toBe(1);

    // Ledgers: exactly one stake + one payout per round, sum == balance.
    for (const [sid, rid] of [[ids.A, roundIds.A], [ids.B, roundIds.B], [ids.D, roundIds.D]] as const) {
      const exp = JSON.parse((await h1.api('GET', `/api/sessions/${sid}/export?format=json`)).text) as SessionExport;
      expect(exp.ledger.filter((e) => e.roundId === rid && e.kind === 'stake')).toHaveLength(1);
      expect(exp.ledger.filter((e) => e.roundId === rid && e.kind === 'payout')).toHaveLength(1);
      expect(ledgerSum(exp.ledger)).toBe(exp.session.balance);
    }
  });

  it('second restart: recover() is a no-op and nothing is drawn, credited or called', async () => {
    const before: Record<string, number> = {};
    for (const sid of Object.values(ids)) before[sid] = (await snapshot(h1!, sid)).session.balance;
    await h1!.close();
    h1 = undefined;

    const outcomes = countingFixtureOutcomes([9, 9, 9, 9]);
    const adapter2 = new FixtureAdapter({ kind: 'anthropic', paid: true, respond: () => fixtureDecision({ action: 'skip' }) });
    h2 = await createHarness({ label: 'restart-2', dbPath, outcomes, adapters: [adapter2] });
    expect(h2.service.recover()).toEqual({ settledRounds: 0, pausedSessions: 0, interruptedDecisions: 0 });
    expect(outcomes.calls).toBe(0);
    for (const sid of Object.values(ids)) {
      const s = await snapshot(h2, sid);
      expect(s.session.balance, sid).toBe(before[sid]);
      const exp = JSON.parse((await h2.api('GET', `/api/sessions/${sid}/export?format=json`)).text) as SessionExport;
      const payouts = exp.ledger.filter((e) => e.kind === 'payout');
      expect(new Set(payouts.map((e) => e.roundId)).size).toBe(payouts.length);
    }
    expect((await snapshot(h2, ids.C)).session.pauseReason).toBe('server_restart');
    await delay(150);
    expect(adapter2.calls).toHaveLength(0);

    // Recovery leaves a consistent, resumable session: an explicit Start continues the demo at seq 2.
    expectOk(await control(h2, ids.D, 'start'), 'resume D');
    const done = await waitForStatus(h2, ids.D, ['completed', 'paused', 'stopped']);
    expect(done.session.status).toBe('completed');
    expect(done.session.endReason).toBe('max_rounds');
    const { rounds } = expectOk(await h2.api<{ rounds: RoundRecord[] }>('GET', `/api/sessions/${ids.D}/rounds`), 'rounds');
    expect(rounds.map((r) => r.seq).sort()).toEqual([1, 2]);
    expect(rounds.find((r) => r.seq === 1)!.winningNumber).toBe(0); // still the stored outcome
    expect(outcomes.calls).toBe(1); // only the new round 2 drew a number
  });
});
