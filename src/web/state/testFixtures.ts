/**
 * TEST FIXTURES ONLY — synthetic records for unit tests of the dashboard state. Never imported by app code.
 * Values follow the contracts (integer subunits, settled rounds carry settlement figures).
 */
import type { RoundRecord, SessionInfo, SessionSnapshot, UsageSummary } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';

export const FIXTURE_SESSION_ID = 'fixture-session';

export function fixtureSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: FIXTURE_SESSION_ID,
    name: 'Fixture session',
    mode: 'manual',
    player: { kind: 'manual' },
    status: 'ready',
    phase: 'ready',
    pauseReason: null,
    endReason: null,
    message: null,
    balance: 1_000_00,
    startingBalance: 1_000_00,
    roundsPlayed: 0,
    limits: DEFAULT_LIMITS,
    epoch: 1,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    runtimeMs: 0,
    ...over,
  };
}

/** A settled straight-up bet round. `win` decides whether the single bet on `number` hit. */
export function fixtureRound(
  seq: number,
  opts: { balanceBefore: number; stake?: number; winningNumber?: number; betNumber?: number; status?: RoundRecord['status'] } ,
): RoundRecord {
  const stake = opts.stake ?? 10_00;
  const betNumber = opts.betNumber ?? 17;
  const winningNumber = opts.winningNumber ?? 5;
  const status = opts.status ?? 'settled';
  const won = winningNumber === betNumber;
  const settled = status === 'settled';
  const returned = won ? stake * 36 : 0;
  return {
    id: `round-${seq}`,
    sessionId: FIXTURE_SESSION_ID,
    seq,
    status,
    source: 'manual',
    decisionId: null,
    bets: [
      {
        key: `straight:${betNumber}`,
        type: 'straight',
        numbers: [betNumber],
        stake,
        payout: 35,
        label: `Straight ${betNumber}`,
        won: settled ? won : null,
        returned: settled ? returned : null,
      },
    ],
    totalStake: stake,
    balanceBefore: opts.balanceBefore,
    winningNumber: status === 'committed' ? null : winningNumber,
    stakeReturned: settled ? (won ? stake : 0) : null,
    winnings: settled ? (won ? stake * 35 : 0) : null,
    totalReturned: settled ? returned : null,
    net: settled ? returned - stake : null,
    balanceAfter: settled ? opts.balanceBefore - stake + returned : null,
    committedAt: `2026-09-23T10:0${seq % 10}:00.000Z`,
    outcomeAt: status === 'committed' ? null : `2026-09-23T10:0${seq % 10}:01.000Z`,
    settledAt: settled ? `2026-09-23T10:0${seq % 10}:01.000Z` : null,
  };
}

export function fixtureUsage(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    requests: 0,
    failedRequests: 0,
    unknownUsageRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    costIsPartial: false,
    costBasis: 'not-applicable',
    lastLatencyMs: null,
    avgLatencyMs: null,
    lastOutputTokensPerSec: null,
    budgetMicros: null,
    budgetRemainingMicros: null,
    lastRateLimit: null,
    ...over,
  };
}

export function fixtureSnapshot(session: SessionInfo, rounds: RoundRecord[], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const newestFirst = [...rounds].sort((a, b) => b.seq - a.seq);
  return {
    session,
    currentRound: newestFirst[0] ?? null,
    recentRounds: newestFirst.filter((r) => r.status === 'settled').slice(0, 20),
    lastDecision: null,
    usage: fixtureUsage(),
    inFlight: { decision: false, round: false },
    ...over,
  };
}
