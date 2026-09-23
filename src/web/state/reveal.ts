/**
 * REVEAL LOGIC — presentation only.
 *
 * The server settles a round (outcome drawn, returns credited) before the browser ever animates it.
 * To keep the wheel meaningful, the UI withholds a round's result until the wheel reports that the
 * ball rests in the pocket (RouletteWheel.onSettled(roundId)). While a round is "hidden":
 *   - the balance shows the pre-spin value (balance before the round minus the stake on the table),
 *   - recent results / last round / ledger / chart do not show that round's outcome ("Spinning…").
 * If the tab is hidden or reduced motion is on, the round is revealed immediately (the wheel still receives
 * the spin so it can show the ball resting in the pocket). At "instant" speed the wheel places the ball in
 * the pocket at once and reports onSettled on the next tick, so the result appears right after the ball.
 *
 * Revealing is a watermark: rounds with seq <= revealedSeq may show their result. Rounds are strictly
 * sequential within a session, so a watermark can never reveal a later round before an earlier one.
 * At most one round animates and at most one waits behind it; if several outcomes arrive while the
 * wheel is busy, only the newest waits and the skipped ones are revealed when it starts spinning.
 */
import type { RoundRecord, SessionInfo, Subunits } from '../../shared/contracts';
import type { WheelSpin } from '../contracts';

export interface RevealItem {
  roundId: string;
  seq: number;
  winningNumber: number;
}

export interface RevealState {
  sessionId: string | null;
  /** Rounds with seq <= revealedSeq may display their result. */
  revealedSeq: number;
  /** Round currently animating (its result is hidden). */
  spinning: RevealItem | null;
  /** Newest outcome waiting for the wheel (its result is hidden). */
  pending: RevealItem | null;
  /** What the wheel is told to show. Stays on the last spin after it settles. */
  wheel: WheelSpin | null;
}

export const INITIAL_REVEAL: RevealState = {
  sessionId: null,
  revealedSeq: 0,
  spinning: null,
  pending: null,
  wheel: null,
};

function toItem(r: RoundRecord): RevealItem | null {
  return r.winningNumber === null ? null : { roundId: r.id, seq: r.seq, winningNumber: r.winningNumber };
}

/**
 * Session (re)loaded: everything already known is history — no animation.
 * The wheel stays idle so an old result is never replayed as if it were the current spin.
 */
export function revealReset(sessionId: string | null, rounds: readonly RoundRecord[]): RevealState {
  let revealedSeq = 0;
  for (const r of rounds) if (r.winningNumber !== null && r.seq > revealedSeq) revealedSeq = r.seq;
  return { ...INITIAL_REVEAL, sessionId, revealedSeq };
}

/** Everything known becomes visible now (tab hidden, reduced motion switched on, watchdog). */
export function revealFlush(state: RevealState): RevealState {
  const last = state.pending ?? state.spinning;
  if (!last) return state;
  return {
    ...state,
    revealedSeq: Math.max(state.revealedSeq, last.seq),
    spinning: null,
    pending: null,
    wheel: { roundId: last.roundId, winningNumber: last.winningNumber },
  };
}

/**
 * A round whose outcome is known arrived (event, snapshot, list or manual-round response).
 * `immediate` = reveal without waiting for the wheel (hidden tab, reduced motion).
 */
export function revealOutcome(state: RevealState, round: RoundRecord, immediate: boolean): RevealState {
  if (state.sessionId !== null && round.sessionId !== state.sessionId) return state;
  const item = toItem(round);
  if (!item || item.seq <= state.revealedSeq) return state;
  if (state.spinning?.roundId === item.roundId || state.pending?.roundId === item.roundId) return state;
  if (state.spinning && item.seq < state.spinning.seq) return state; // older than what is spinning

  if (immediate) {
    const latest = state.pending && state.pending.seq > item.seq ? state.pending : item;
    return {
      ...state,
      revealedSeq: Math.max(state.revealedSeq, latest.seq),
      spinning: null,
      pending: null,
      wheel: { roundId: latest.roundId, winningNumber: latest.winningNumber },
    };
  }
  if (!state.spinning) {
    return { ...state, spinning: item, wheel: { roundId: item.roundId, winningNumber: item.winningNumber } };
  }
  if (!state.pending || item.seq > state.pending.seq) return { ...state, pending: item };
  return state;
}

/** RouletteWheel.onSettled(roundId). Stale or duplicate calls are ignored. */
export function revealSettled(state: RevealState, roundId: string): RevealState {
  const s = state.spinning;
  if (!s || s.roundId !== roundId) return state;
  const next = state.pending;
  if (!next) return { ...state, revealedSeq: Math.max(state.revealedSeq, s.seq), spinning: null };
  // Rounds skipped between the two animations are revealed as the next spin starts.
  return {
    ...state,
    revealedSeq: Math.max(state.revealedSeq, s.seq, next.seq - 1),
    spinning: next,
    pending: null,
    wheel: { roundId: next.roundId, winningNumber: next.winningNumber },
  };
}

// ───────────────────────────── derived presentation ─────────────────────────────

export interface Presentation {
  /** Balance to display (pre-spin while a result is hidden). */
  balance: Subunits;
  /** Net of revealed rounds only (excludes stake currently on the table). */
  sessionNet: Subunits;
  /** Stake committed for the round in play / spinning; 0 when none. */
  stakeOnTable: Subunits;
  /** Latest revealed, settled round. */
  lastRound: RoundRecord | null;
  /** Revealed settled rounds, newest first. */
  revealedRounds: RoundRecord[];
  /** Round the wheel is animating (result hidden), if any. */
  spinningRound: RoundRecord | null;
  /** Round committed on the server but not settled yet (and not hidden): stake on the table. */
  inPlayRound: RoundRecord | null;
  animating: boolean;
  /** Winning number the table may highlight (revealed only, never during a spin). */
  highlightNumber: number | null;
  revealedSeq: number;
  /**
   * Earliest hidden round (seq + outcome time). Anything produced after it — the next decision (whose
   * explanation may quote the result), later log lines — is held back too, so nothing leaks the result.
   */
  hiddenFrom: { seq: number; at: string | null } | null;
}

/** Decisions for rounds after a hidden round are held back until it is revealed. */
export function isDecisionVisible(roundNumber: number, p: Pick<Presentation, 'hiddenFrom'>): boolean {
  return !p.hiddenFrom || roundNumber <= p.hiddenFrom.seq;
}

/** Log lines written at/after a hidden round's outcome are held back until it is revealed. */
export function isLogVisible(createdAt: string, p: Pick<Presentation, 'hiddenFrom'>): boolean {
  return !p.hiddenFrom || p.hiddenFrom.at === null || createdAt < p.hiddenFrom.at;
}

/**
 * Derive everything the UI shows about money and results from server state + the reveal watermark.
 * `rounds` may be in any order and may contain the snapshot's currentRound/recentRounds.
 */
export function present(session: SessionInfo, rounds: readonly RoundRecord[], reveal: RevealState): Presentation {
  const own = rounds.filter((r) => r.sessionId === session.id);
  const sorted = [...own].sort((a, b) => b.seq - a.seq); // newest first
  const revealedRounds = sorted.filter((r) => r.status === 'settled' && r.seq <= reveal.revealedSeq);
  const hidden = sorted.filter((r) => r.winningNumber !== null && r.seq > reveal.revealedSeq);
  const firstHidden = hidden.length ? hidden[hidden.length - 1]! : null;
  // Not yet settled on the server and not hidden: stake is on the table, no result to show yet.
  const inPlayRound =
    sorted.find((r) => r.status !== 'settled' && !(r.winningNumber !== null && r.seq > reveal.revealedSeq)) ??
    null;

  let balance: Subunits;
  let sessionNet: Subunits;
  let stakeOnTable: Subunits;
  if (firstHidden) {
    balance = firstHidden.balanceBefore - firstHidden.totalStake;
    sessionNet = firstHidden.balanceBefore - session.startingBalance;
    stakeOnTable = firstHidden.totalStake;
  } else if (inPlayRound) {
    balance = session.balance;
    sessionNet = inPlayRound.balanceBefore - session.startingBalance;
    stakeOnTable = inPlayRound.totalStake;
  } else {
    balance = session.balance;
    sessionNet = session.balance - session.startingBalance;
    stakeOnTable = 0;
  }

  const spinningRound = reveal.spinning ? (own.find((r) => r.id === reveal.spinning!.roundId) ?? null) : null;
  const animating = reveal.spinning !== null;
  const lastRound = revealedRounds[0] ?? null;
  return {
    balance,
    sessionNet,
    stakeOnTable,
    lastRound,
    revealedRounds,
    spinningRound,
    inPlayRound,
    animating,
    highlightNumber: animating || hidden.length > 0 ? null : (lastRound?.winningNumber ?? null),
    revealedSeq: reveal.revealedSeq,
    hiddenFrom: firstHidden ? { seq: firstHidden.seq, at: firstHidden.outcomeAt } : null,
  };
}
