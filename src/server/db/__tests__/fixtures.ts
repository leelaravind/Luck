/**
 * TEST FIXTURES for the persistence tests (not shipped; excluded from the server build).
 * Bets and settlements here are hand-built from the documented contract (payout "X to 1",
 * returned = stake × (payout + 1) on a win) so these tests do not depend on the rules module.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_LIMITS,
  type DecisionRecord,
  type ResolvedBet,
  type Settlement,
  type UsageRecord,
} from '../../../shared/contracts.js';
import { RED_NUMBERS } from '../../../shared/roulette.js';
import type { NewSession, Repository } from '../../types.js';

/** H:\LUCKY\Luck\tmp\3 — this agent's scratch directory (gitignored). */
export const TMP_ROOT = fileURLToPath(new URL('../../../../tmp/3/', import.meta.url));

/** A fresh directory under tmp/3 plus a cleanup function. */
export function tmpDir(label: string): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = join(TMP_ROOT, `${label}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    dbPath: join(dir, 'nested', 'luck.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export const T0 = '2026-09-23T10:00:00.000Z';
export const at = (sec: number): string => new Date(Date.parse(T0) + sec * 1000).toISOString();

export function newSession(id: string, overrides: Partial<NewSession> = {}): NewSession {
  return {
    id,
    name: `Session ${id}`,
    mode: 'manual',
    player: { kind: 'manual' },
    limits: { ...DEFAULT_LIMITS },
    createdAt: T0,
    ...overrides,
  };
}

// ── fixture bets (hand-built ResolvedBet values) ──

export const redBet = (stake: number): ResolvedBet => ({
  key: 'red',
  type: 'red',
  numbers: [...RED_NUMBERS].sort((a, b) => a - b),
  stake,
  payout: 1,
  label: 'Red',
});

export const straightBet = (n: number, stake: number): ResolvedBet => ({
  key: `straight:${n}`,
  type: 'straight',
  numbers: [n],
  stake,
  payout: 35,
  label: `Straight ${n}`,
});

export const splitZeroThree = (stake: number): ResolvedBet => ({
  key: 'split:0-3',
  type: 'split',
  numbers: [0, 3],
  stake,
  payout: 17,
  label: 'Split 0/3',
});

export const dozenBet = (index: 1 | 2 | 3, stake: number): ResolvedBet => ({
  key: `dozen:${index}`,
  type: 'dozen',
  numbers: Array.from({ length: 12 }, (_, i) => (index - 1) * 12 + i + 1),
  index,
  stake,
  payout: 2,
  label: `${['1st', '2nd', '3rd'][index - 1]} Dozen`,
});

/** Fixture settlement computed straight from the contract definitions (integer math). */
export function settleFixture(bets: readonly ResolvedBet[], winningNumber: number): Settlement {
  let totalStake = 0;
  let stakeReturned = 0;
  let winnings = 0;
  const results = bets.map((b) => {
    totalStake += b.stake;
    const won = b.numbers.includes(winningNumber);
    if (won) {
      stakeReturned += b.stake;
      winnings += b.stake * b.payout;
    }
    return { key: b.key, won, returned: won ? b.stake * (b.payout + 1) : 0 };
  });
  const totalReturned = stakeReturned + winnings;
  return { winningNumber, totalStake, stakeReturned, winnings, totalReturned, net: totalReturned - totalStake, bets: results };
}

/** Commit → record outcome → settle, returning the settled round. */
export function playRound(
  repo: Repository,
  sessionId: string,
  roundId: string,
  bets: ResolvedBet[],
  winningNumber: number,
  sec = 0,
) {
  repo.commitRound({
    id: roundId,
    sessionId,
    source: 'manual',
    decisionId: null,
    bets,
    idempotencyKey: `idem-${roundId}`,
    committedAt: at(sec),
  });
  repo.recordOutcome(roundId, winningNumber, at(sec + 1));
  return repo.settleRound(roundId, settleFixture(bets, winningNumber), at(sec + 2));
}

export function decision(sessionId: string, id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    sessionId,
    roundNumber: 1,
    epoch: 0,
    providerKind: 'ollama',
    model: 'fixture-model',
    status: 'pending',
    action: null,
    bets: null,
    explanation: null,
    rawOutput: null,
    validationErrors: [],
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    startedAt: T0,
    completedAt: null,
    latencyMs: null,
    ...overrides,
  };
}

export function usage(sessionId: string, decisionId: string, id: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    sessionId,
    decisionId,
    attempt: 1,
    providerKind: 'ollama',
    model: 'fixture-model',
    status: 'ok',
    inputTokens: 812,
    outputTokens: 64,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    known: true,
    latencyMs: 1234.5,
    generationMs: 900.25,
    outputTokensPerSec: 71.1,
    costMicros: null,
    costBasis: 'local-no-charge',
    rateLimit: null,
    createdAt: T0,
    ...overrides,
  };
}

/** Sum of all ledger amounts for a session (must equal the session balance). */
export function ledgerSum(repo: Repository, sessionId: string): number {
  return repo.listLedger(sessionId).reduce((sum, e) => sum + e.amount, 0);
}
