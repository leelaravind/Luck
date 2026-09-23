// Unit tests for the dashboard store reducer (fixture data only).
import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, luckReducer, mergeRounds, type LuckAction, type LuckState } from './luckReducer';
import { present } from './reveal';
import { FIXTURE_SESSION_ID, fixtureRound, fixtureSession, fixtureSnapshot } from './testFixtures';

const START = 1_000_00;

function run(state: LuckState, ...actions: LuckAction[]): LuckState {
  return actions.reduce(luckReducer, state);
}

function loaded(): LuckState {
  const r1 = fixtureRound(1, { balanceBefore: START });
  const session = fixtureSession({ balance: r1.balanceAfter!, roundsPlayed: 1 });
  return run(
    INITIAL_STATE,
    { type: 'select', sessionId: FIXTURE_SESSION_ID },
    { type: 'sessionLoaded', snapshot: fixtureSnapshot(session, [r1]), rounds: [r1], decisions: [], logs: [], usage: [] },
  );
}

describe('luckReducer', () => {
  it('loads a session with all known rounds as history', () => {
    const s = loaded();
    expect(s.snapshot?.session.id).toBe(FIXTURE_SESSION_ID);
    expect(s.reveal.revealedSeq).toBe(1);
    expect(s.reveal.wheel).toBeNull();
    expect(s.sessions.map((x) => x.id)).toEqual([FIXTURE_SESSION_ID]);
  });

  it('a snapshot event with a newly settled round keeps the result hidden until wheelSettled', () => {
    const s0 = loaded();
    const r1 = s0.rounds[0]!;
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter!, winningNumber: 17, betNumber: 17 });
    const session = fixtureSession({ balance: r2.balanceAfter!, roundsPlayed: 2, updatedAt: '2026-09-23T10:05:00.000Z' });
    const s1 = run(s0, { type: 'snapshot', snapshot: fixtureSnapshot(session, [r1, r2]), immediate: false });

    // Server state is stored as-is…
    expect(s1.snapshot?.session.balance).toBe(r2.balanceAfter);
    // …but the presentation still shows the pre-spin balance and no round-2 result.
    const during = present(s1.snapshot!.session, s1.rounds, s1.reveal);
    expect(during.balance).toBe(r1.balanceAfter! - r2.totalStake);
    expect(during.lastRound?.seq).toBe(1);
    expect(during.revealedRounds.map((r) => r.seq)).toEqual([1]);
    expect(s1.reveal.wheel).toEqual({ roundId: 'round-2', winningNumber: 17 });

    const s2 = run(s1, { type: 'wheelSettled', roundId: 'round-2' });
    const after = present(s2.snapshot!.session, s2.rounds, s2.reveal);
    expect(after.balance).toBe(r2.balanceAfter);
    expect(after.lastRound?.seq).toBe(2);
  });

  it('reveals immediately when the action is flagged immediate (reduced motion / hidden tab)', () => {
    const s0 = loaded();
    const r2 = fixtureRound(2, { balanceBefore: s0.rounds[0]!.balanceAfter! });
    const s1 = run(s0, { type: 'rounds', rounds: [r2], immediate: true });
    const p = present(s1.snapshot!.session, s1.rounds, s1.reveal);
    expect(s1.reveal.revealedSeq).toBe(2);
    expect(p.lastRound?.seq).toBe(2);
    expect(p.animating).toBe(false);
  });

  it('ignores an older snapshot delivered after a newer one', () => {
    const s0 = loaded();
    const newer = fixtureSession({ balance: 5, updatedAt: '2026-09-23T11:00:00.000Z' });
    const older = fixtureSession({ balance: 7, updatedAt: '2026-09-23T10:30:00.000Z' });
    const s = run(
      s0,
      { type: 'snapshot', snapshot: fixtureSnapshot(newer, []), immediate: false },
      { type: 'snapshot', snapshot: fixtureSnapshot(older, []), immediate: false },
    );
    expect(s.snapshot?.session.balance).toBe(5);
  });

  it('never regresses a round to an earlier lifecycle status', () => {
    const settled = fixtureRound(3, { balanceBefore: START });
    const committed = { ...fixtureRound(3, { balanceBefore: START, status: 'committed' }) };
    expect(mergeRounds([settled], [committed])[0]!.status).toBe('settled');
    expect(mergeRounds([committed], [settled])[0]!.status).toBe('settled');
  });

  it('drops events for sessions other than the selected one (except the session list)', () => {
    const s0 = loaded();
    const other = fixtureSession({ id: 'other-session', name: 'Other' });
    const s1 = run(s0, { type: 'snapshot', snapshot: fixtureSnapshot(other, []), immediate: false });
    expect(s1.snapshot?.session.id).toBe(FIXTURE_SESSION_ID);
    expect(s1.sessions.map((x) => x.id).sort()).toEqual([FIXTURE_SESSION_ID, 'other-session'].sort());
    const foreignRound = { ...fixtureRound(9, { balanceBefore: 0 }), sessionId: 'other-session' };
    expect(run(s1, { type: 'rounds', rounds: [foreignRound], immediate: false }).rounds).toHaveLength(1);
  });

  it('tracks per-provider busy flags independently', () => {
    const s = run(
      INITIAL_STATE,
      { type: 'busyProvider', field: 'testing', kind: 'ollama', value: true },
      { type: 'busyProvider', field: 'testing', kind: 'anthropic', value: true },
      { type: 'busyProvider', field: 'testing', kind: 'ollama', value: false },
    );
    expect(s.busy.testing).toEqual({ ollama: false, anthropic: true });
  });
});
