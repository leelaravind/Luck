/**
 * Hard-crash recovery tests. A CHILD PROCESS opens the real repository on a file database,
 * writes a FIXTURE round and is then killed with SIGKILL (no close(), no WAL checkpoint):
 *   after-commit   killed after commitRound returned
 *   after-outcome  killed after recordOutcome returned
 *   during-commit  killed inside commitRound, just before its COMMIT statement
 *   during-settle  killed inside settleRound, just before its COMMIT statement
 * The parent then reopens the file and checks what survived.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Repository } from '../types.js';
import { ledgerSum, settleFixture, straightBet, tmpDir } from './__tests__/fixtures.js';
import { openRepository } from './sqlite.js';

const SQLITE_TS = fileURLToPath(new URL('./sqlite.ts', import.meta.url));
const CONTRACTS_TS = fileURLToPath(new URL('../../shared/contracts.ts', import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

// Plain JS so the child needs nothing but the tsx loader for the .ts imports.
const CHILD = String.raw`
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [sqlitePath, contractsPath, dbPath, scenario] = process.argv.slice(2);
const { openRepository } = await import(pathToFileURL(sqlitePath).href);
const { DEFAULT_LIMITS } = await import(pathToFileURL(contractsPath).href);

const die = (marker) => { writeSync(1, marker + '\n'); process.kill(process.pid, 'SIGKILL'); };

// Fault injection: kill the process when the armed operation reaches COMMIT.
let armed = false;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (armed && sql === 'COMMIT') die('KILLED_BEFORE_COMMIT');
  return exec.call(this, sql);
};

const repo = openRepository(dbPath);
const T = (s) => new Date(Date.UTC(2026, 8, 23, 10, 0, s)).toISOString();
const bets = [
  { key: 'straight:9', type: 'straight', numbers: [9], stake: 100, payout: 35, label: 'Straight 9' },
];
repo.createSession({ id: 's1', name: 'crash', mode: 'demo', player: { kind: 'demo' }, limits: DEFAULT_LIMITS, createdAt: T(0) });
const commit = () => repo.commitRound({ id: 'r1', sessionId: 's1', source: 'demo', decisionId: null, bets, idempotencyKey: 'k1', committedAt: T(1) });

if (scenario === 'during-commit') { armed = true; commit(); }
commit();
if (scenario === 'after-commit') die('KILLED_AFTER_COMMIT');
repo.recordOutcome('r1', 9, T(2));
if (scenario === 'after-outcome') die('KILLED_AFTER_OUTCOME');
if (scenario === 'during-settle') {
  armed = true;
  repo.settleRound('r1', { winningNumber: 9, totalStake: 100, stakeReturned: 100, winnings: 3500, totalReturned: 3600, net: 3500,
    bets: [{ key: 'straight:9', won: true, returned: 3600 }] }, T(3));
}
writeSync(1, 'NOT_KILLED\n');
`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function crashChild(scenario: string): { repo: Repository; dbPath: string; stdout: string } {
  const tmp = tmpDir(`crash-${scenario}`);
  const childFile = join(tmp.dir, 'crash-child.mjs');
  writeFileSync(childFile, CHILD);
  const res = spawnSync(process.execPath, ['--no-warnings', '--import', TSX_LOADER, childFile, SQLITE_TS, CONTRACTS_TS, tmp.dbPath, scenario], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  const stdout = res.stdout ?? '';
  if (!stdout.includes('KILLED')) throw new Error(`child did not reach the crash point:\n${stdout}\n${res.stderr}`);
  // A hard kill leaves the WAL behind (a clean close would checkpoint and remove it).
  expect(res.status === 0 && res.signal === null).toBe(false);
  expect(existsSync(`${tmp.dbPath}-wal`)).toBe(true);
  const repo = openRepository(tmp.dbPath);
  cleanups.push(() => {
    repo.close();
    tmp.cleanup();
  });
  return { repo, dbPath: tmp.dbPath, stdout };
}

const BET = [straightBet(9, 100)];
const START = 100_000;

describe('recovery after a hard process kill (child process, FIXTURE bets)', () => {
  it('after-commit: the round is committed, stake debited, no outcome; it can be drawn and settled once', () => {
    const { repo, stdout } = crashChild('after-commit');
    expect(stdout).toContain('KILLED_AFTER_COMMIT');
    expect(repo.findUnsettledRounds().map((r) => [r.id, r.status, r.winningNumber])).toEqual([['r1', 'committed', null]]);
    expect(repo.getSession('s1')!.balance).toBe(START - 100);
    expect(ledgerSum(repo, 's1')).toBe(START - 100);
    repo.recordOutcome('r1', 4, new Date().toISOString());
    expect(repo.settleRound('r1', settleFixture(BET, 4), new Date().toISOString()).applied).toBe(true);
    expect(repo.settleRound('r1', settleFixture(BET, 4), new Date().toISOString()).applied).toBe(false);
    expect(repo.findUnsettledRounds()).toEqual([]);
    expect(repo.getSession('s1')).toMatchObject({ balance: START - 100, roundsPlayed: 1 });
  });

  it('after-outcome: the stored outcome survives and is never redrawn', () => {
    const { repo } = crashChild('after-outcome');
    expect(repo.findUnsettledRounds().map((r) => [r.id, r.status, r.winningNumber])).toEqual([['r1', 'outcome_recorded', 9]]);
    // A recovery path that (wrongly) draws again still gets the stored number back.
    expect(repo.recordOutcome('r1', 22, new Date().toISOString()).winningNumber).toBe(9);
    expect(repo.settleRound('r1', settleFixture(BET, 9), new Date().toISOString()).applied).toBe(true);
    expect(repo.getSession('s1')).toMatchObject({ balance: START - 100 + 3_600, roundsPlayed: 1 });
    expect(ledgerSum(repo, 's1')).toBe(START + 3_500);
  });

  it('during-commit: nothing of the half-written round survives', () => {
    const { repo, stdout } = crashChild('during-commit');
    expect(stdout).toContain('KILLED_BEFORE_COMMIT');
    expect(repo.findUnsettledRounds()).toEqual([]);
    expect(repo.getRound('r1')).toBeNull();
    expect(repo.findRoundByIdempotencyKey('s1', 'k1')).toBeNull();
    expect(repo.getSession('s1')!.balance).toBe(START);
    expect(repo.listLedger('s1').map((e) => e.kind)).toEqual(['session_start']);
  });

  it('during-settle: settlement is all-or-nothing; the round can still be settled exactly once', () => {
    const { repo, stdout } = crashChild('during-settle');
    expect(stdout).toContain('KILLED_BEFORE_COMMIT');
    const r = repo.getRound('r1')!;
    expect(r).toMatchObject({ status: 'outcome_recorded', winningNumber: 9, totalReturned: null, balanceAfter: null });
    expect(r.bets[0]).toMatchObject({ won: null, returned: null });
    expect(repo.getSession('s1')).toMatchObject({ balance: START - 100, roundsPlayed: 0 });
    expect(repo.listLedger('s1').filter((e) => e.kind === 'payout')).toHaveLength(0);
    expect(repo.settleRound('r1', settleFixture(BET, 9), new Date().toISOString()).applied).toBe(true);
    expect(repo.getSession('s1')).toMatchObject({ balance: START + 3_500, roundsPlayed: 1 });
    expect(repo.listLedger('s1').filter((e) => e.kind === 'payout')).toHaveLength(1);
  });
});
