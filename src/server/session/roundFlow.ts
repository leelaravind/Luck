/**
 * The round flow shared by manual play, the demo player and AI players:
 *
 *   commitRound (bets persisted + stake deducted)          phase 'committed'
 *   → emit 'round' (winningNumber null)
 *   → outcomeSource.next()   ← ONLY after the commit succeeded
 *   → recordOutcome                                        phase 'outcome_recorded'
 *   → settleBets + settleRound (credited exactly once)     phase 'settled'
 *   → emit 'round' + 'snapshot'
 *
 * Everything here is synchronous, so a round can never be interleaved with another request on the
 * same event loop. If the process dies between steps, recovery (settleStoredRound) resumes from the
 * persisted status and never redraws an existing outcome.
 */
import { randomUUID } from 'node:crypto';
import type { ResolvedBet, RoundBet, RoundRecord, RoundSource, SessionPhase, Settlement } from '../../shared/contracts.js';
import { settleBets } from '../../shared/bets.js';
import type { OutcomeSource, Repository } from '../types.js';

export interface RoundFlowDeps {
  repo: Repository;
  outcomeSource: OutcomeSource;
  nowIso(): string;
  emitRound(round: RoundRecord): void;
  emitSnapshot(sessionId: string): void;
}

export interface PlayRoundInput {
  sessionId: string;
  source: RoundSource;
  decisionId: string | null;
  /** Already validated by validateBetSlip; empty = a no-bet (skip) round. */
  bets: ResolvedBet[];
  idempotencyKey: string | null;
}

export interface PlayRoundResult {
  round: RoundRecord;
  /** true when the idempotency key matched an earlier round: nothing was charged or drawn. */
  replayed: boolean;
}

export function playRound(deps: RoundFlowDeps, input: PlayRoundInput): PlayRoundResult {
  const { repo } = deps;
  const id = randomUUID();
  const committed = repo.commitRound({
    id,
    sessionId: input.sessionId,
    source: input.source,
    decisionId: input.decisionId,
    bets: input.bets,
    idempotencyKey: input.idempotencyKey,
    committedAt: deps.nowIso(),
  });
  if (committed.id !== id) {
    // Idempotent replay: the repository returned the earlier round unchanged. No new outcome.
    return { round: committed, replayed: true };
  }

  setPhase(deps, input.sessionId, 'committed');
  deps.emitRound(committed);
  deps.emitSnapshot(input.sessionId);

  const settled = settleStoredRound(deps, committed);
  return { round: settled, replayed: false };
}

/**
 * Finish a persisted round from whatever status it is in:
 *  - committed        → draw the (first and only) outcome, record it, settle
 *  - outcome_recorded → settle with the STORED winning number (never redraw)
 *  - settled          → returned unchanged
 */
export function settleStoredRound(deps: RoundFlowDeps, round: RoundRecord): RoundRecord {
  const { repo } = deps;
  let current = round;

  if (current.status === 'committed') {
    const winningNumber = deps.outcomeSource.next();
    current = repo.recordOutcome(current.id, winningNumber, deps.nowIso());
    setPhase(deps, current.sessionId, 'outcome_recorded');
  }

  if (current.status === 'outcome_recorded') {
    if (current.winningNumber === null) throw new Error(`Round ${current.id} has status outcome_recorded but no number`);
    const settlement = computeSettlement(current.bets, current.winningNumber);
    const { round: settled } = repo.settleRound(current.id, settlement, deps.nowIso());
    current = settled;
    setPhase(deps, current.sessionId, 'settled');
    deps.emitRound(current);
    deps.emitSnapshot(current.sessionId);
  }

  return current;
}

/** Settlement for stored round bets. A no-bet round settles to all zeros. */
export function computeSettlement(bets: readonly RoundBet[], winningNumber: number): Settlement {
  if (bets.length === 0) {
    return { winningNumber, totalStake: 0, stakeReturned: 0, winnings: 0, totalReturned: 0, net: 0, bets: [] };
  }
  return settleBets(roundBetsToResolved(bets), winningNumber);
}

export function roundBetsToResolved(bets: readonly RoundBet[]): ResolvedBet[] {
  return bets.map((b) => {
    const r: ResolvedBet = { key: b.key, type: b.type, numbers: [...b.numbers], stake: b.stake, payout: b.payout, label: b.label };
    if (b.index !== undefined && b.index !== null) r.index = b.index;
    return r;
  });
}

function setPhase(deps: RoundFlowDeps, sessionId: string, phase: SessionPhase): void {
  deps.repo.updateSession(sessionId, { phase });
}
