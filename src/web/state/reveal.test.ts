// Unit tests for the presentation-only reveal logic (fixture data, no server).
import { describe, expect, it } from 'vitest';
import {
  INITIAL_REVEAL,
  isDecisionVisible,
  isLogVisible,
  present,
  revealFlush,
  revealOutcome,
  revealReset,
  revealSettled,
  type RevealState,
} from './reveal';
import { FIXTURE_SESSION_ID, fixtureRound, fixtureSession } from './testFixtures';

const START = 1_000_00;

describe('reveal state machine', () => {
  it('treats everything known at load time as history (no animation, wheel idle)', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter! });
    const s = revealReset(FIXTURE_SESSION_ID, [r1, r2]);
    expect(s.revealedSeq).toBe(2);
    expect(s.spinning).toBeNull();
    expect(s.wheel).toBeNull();
  });

  it('hides a new outcome until the wheel reports onSettled for that round', () => {
    const r1 = fixtureRound(1, { balanceBefore: START, stake: 10_00, winningNumber: 17, betNumber: 17 }); // win
    let s = revealReset(FIXTURE_SESSION_ID, []);
    s = revealOutcome(s, r1, false);
    expect(s.spinning?.roundId).toBe('round-1');
    expect(s.wheel).toEqual({ roundId: 'round-1', winningNumber: 17 });
    expect(s.revealedSeq).toBe(0);

    const session = fixtureSession({ balance: r1.balanceAfter!, roundsPlayed: 1 });
    const during = present(session, [r1], s);
    // Pre-spin balance: before the round minus the stake on the table — NOT the settled balance.
    expect(during.balance).toBe(START - 10_00);
    expect(during.balance).not.toBe(r1.balanceAfter);
    expect(during.lastRound).toBeNull();
    expect(during.revealedRounds).toHaveLength(0);
    expect(during.highlightNumber).toBeNull();
    expect(during.animating).toBe(true);
    expect(during.stakeOnTable).toBe(10_00);
    expect(during.sessionNet).toBe(0);

    // A stale / unrelated onSettled is ignored.
    expect(revealSettled(s, 'round-999')).toBe(s);

    s = revealSettled(s, 'round-1');
    const after = present(session, [r1], s);
    expect(after.balance).toBe(r1.balanceAfter);
    expect(after.lastRound?.id).toBe('round-1');
    expect(after.revealedRounds.map((r) => r.seq)).toEqual([1]);
    expect(after.highlightNumber).toBe(17);
    expect(after.animating).toBe(false);
    expect(after.sessionNet).toBe(r1.balanceAfter! - START);
    // The wheel keeps showing the settled spin (no replay of an older result).
    expect(s.wheel).toEqual({ roundId: 'round-1', winningNumber: 17 });
  });

  it('reveals immediately when reduced motion / hidden tab (immediate = true)', () => {
    const r1 = fixtureRound(1, { balanceBefore: START, winningNumber: 3 });
    const s = revealOutcome(revealReset(FIXTURE_SESSION_ID, []), r1, true);
    expect(s.spinning).toBeNull();
    expect(s.revealedSeq).toBe(1);
    // The wheel still receives the spin so it can rest the ball in the pocket.
    expect(s.wheel).toEqual({ roundId: 'round-1', winningNumber: 3 });
    const p = present(fixtureSession({ balance: r1.balanceAfter! }), [r1], s);
    expect(p.balance).toBe(r1.balanceAfter);
    expect(p.lastRound?.seq).toBe(1);
  });

  it('flush (tab hidden mid-spin) reveals the spinning and waiting rounds at once', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter! });
    let s = revealOutcome(revealReset(FIXTURE_SESSION_ID, []), r1, false);
    s = revealOutcome(s, r2, false);
    expect(s.pending?.roundId).toBe('round-2');
    s = revealFlush(s);
    expect(s.revealedSeq).toBe(2);
    expect(s.spinning).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.wheel?.roundId).toBe('round-2');
  });

  it('queues at most one outcome behind the current spin and reveals skipped rounds when it starts', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter! });
    const r3 = fixtureRound(3, { balanceBefore: r2.balanceAfter! });
    let s: RevealState = revealReset(FIXTURE_SESSION_ID, []);
    s = revealOutcome(s, r1, false);
    s = revealOutcome(s, r2, false);
    s = revealOutcome(s, r3, false);
    expect(s.spinning?.seq).toBe(1);
    expect(s.pending?.seq).toBe(3); // newest waits, round 2 is skipped (never animated)

    const session = fixtureSession({ balance: r3.balanceAfter! });
    expect(present(session, [r1, r2, r3], s).balance).toBe(START - r1.totalStake);

    s = revealSettled(s, 'round-1');
    expect(s.spinning?.seq).toBe(3);
    expect(s.revealedSeq).toBe(2); // rounds 1 and 2 visible, 3 still hidden
    const mid = present(session, [r1, r2, r3], s);
    expect(mid.revealedRounds.map((r) => r.seq)).toEqual([2, 1]);
    expect(mid.balance).toBe(r3.balanceBefore - r3.totalStake);

    s = revealSettled(s, 'round-3');
    expect(s.revealedSeq).toBe(3);
    expect(present(session, [r1, r2, r3], s).balance).toBe(r3.balanceAfter);
  });

  it('ignores duplicates, already revealed rounds, rounds without outcome and other sessions', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    let s = revealOutcome(revealReset(FIXTURE_SESSION_ID, []), r1, false);
    expect(revealOutcome(s, r1, false)).toBe(s); // duplicate event
    s = revealSettled(s, 'round-1');
    expect(revealOutcome(s, r1, false)).toBe(s); // already revealed
    const committed = fixtureRound(2, { balanceBefore: r1.balanceAfter!, status: 'committed' });
    expect(revealOutcome(s, committed, false)).toBe(s);
    const foreign = { ...fixtureRound(2, { balanceBefore: 0 }), sessionId: 'other' };
    expect(revealOutcome(s, foreign, false)).toBe(s);
  });

  it('shows a committed round (no outcome yet) as stake on the table without a result', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter!, status: 'committed', stake: 5_00 });
    const session = fixtureSession({ balance: r1.balanceAfter! - 5_00 });
    const p = present(session, [r1, r2], revealReset(FIXTURE_SESSION_ID, [r1, r2]));
    expect(p.inPlayRound?.seq).toBe(2);
    expect(p.stakeOnTable).toBe(5_00);
    expect(p.balance).toBe(session.balance);
    expect(p.sessionNet).toBe(r1.balanceAfter! - START);
    expect(p.lastRound?.seq).toBe(1);
  });

  it('holds back decisions and logs produced after a hidden outcome', () => {
    const r1 = fixtureRound(1, { balanceBefore: START });
    const s = revealOutcome(revealReset(FIXTURE_SESSION_ID, []), r1, false);
    const p = present(fixtureSession({ balance: r1.balanceAfter! }), [r1], s);
    expect(p.hiddenFrom).toEqual({ seq: 1, at: r1.outcomeAt });
    expect(isDecisionVisible(1, p)).toBe(true); // the spinning round's own decision
    expect(isDecisionVisible(2, p)).toBe(false); // next decision may quote the result
    expect(isLogVisible('2026-09-23T10:00:00.000Z', p)).toBe(true);
    expect(isLogVisible(r1.outcomeAt!, p)).toBe(false);
    const revealed = present(fixtureSession(), [r1], revealSettled(s, 'round-1'));
    expect(revealed.hiddenFrom).toBeNull();
    expect(isDecisionVisible(2, revealed)).toBe(true);
  });

  it('INITIAL_REVEAL starts with nothing revealed and the wheel idle', () => {
    expect(INITIAL_REVEAL).toMatchObject({ revealedSeq: 0, spinning: null, pending: null, wheel: null });
  });
});
