/**
 * Repository tests against real SQLite (node:sqlite). In-memory databases for semantics,
 * file databases under tmp/3 for persistence, WAL, raw-constraint and rollback checks.
 * All bets/settlements are FIXTURES (see __tests__/fixtures.ts).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { GameError, HTTP_STATUS_FOR } from '../../shared/contracts.js';
import type { Repository } from '../types.js';
import {
  at,
  decision,
  dozenBet,
  ledgerSum,
  newSession,
  playRound,
  redBet,
  settleFixture,
  splitZeroThree,
  straightBet,
  T0,
  tmpDir,
  usage,
} from './__tests__/fixtures.js';
import { MIGRATIONS, SCHEMA_ENUMS, SCHEMA_VERSION } from './schema.js';
import { openRepository } from './sqlite.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function memRepo(): Repository {
  const repo = openRepository(':memory:');
  cleanups.push(() => repo.close());
  return repo;
}

/** File-backed repo plus a raw second connection for inspecting/tampering with the file. */
function fileRepo(label: string) {
  const tmp = tmpDir(label);
  const repo = openRepository(tmp.dbPath);
  const raws: DatabaseSync[] = [];
  const raw = () => {
    const db = new DatabaseSync(tmp.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    raws.push(db);
    return db;
  };
  cleanups.push(() => {
    for (const db of raws) if (db.isOpen) db.close();
    repo.close();
    tmp.cleanup();
  });
  return { repo, raw, ...tmp };
}

function expectGameError(fn: () => unknown, code: string): GameError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe(code);
    return err as GameError;
  }
  throw new Error(`expected GameError(${code}) but nothing was thrown`);
}

const count = (db: DatabaseSync, sql: string, ...p: string[]) =>
  (db.prepare(sql).get(...p) as { n: number }).n;

// ───────────────────────────── opening & schema ─────────────────────────────

describe('openRepository', () => {
  it('opens :memory: and migrates to the current schema version', () => {
    const repo = memRepo();
    expect(repo.listSessions()).toEqual([]);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('creates the parent directory, uses WAL, sets user_version and enforces foreign keys', () => {
    const { repo, raw, dbPath } = fileRepo('open');
    expect(existsSync(dbPath)).toBe(true);
    repo.createSession(newSession('s1'));
    const db = raw();
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    // FK enforcement: usage for a decision that does not exist is refused.
    expectGameError(() => repo.insertUsage(usage('s1', 'no-such-decision', 'u1')), 'not_found');
  });

  it('reopens an existing database without re-running migrations', () => {
    const tmp = tmpDir('reopen');
    cleanups.push(tmp.cleanup);
    const a = openRepository(tmp.dbPath);
    a.createSession(newSession('s1'));
    a.close();
    const b = openRepository(tmp.dbPath);
    expect(b.getSession('s1')?.balance).toBe(100_000);
    b.close();
  });

  it('refuses a database written by a newer schema version', () => {
    const tmp = tmpDir('future');
    cleanups.push(tmp.cleanup);
    openRepository(tmp.dbPath).close();
    const db = new DatabaseSync(tmp.dbPath);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openRepository(tmp.dbPath)).toThrow(/newer than this build supports/);
  });

  it('migrates a version-1 database forward (decisions gain provider_note, existing rows read back as null)', () => {
    const again = tmpDir('migrate-v1');
    cleanups.push(again.cleanup);
    // Build a database exactly as a v1 build left it, with one stored decision.
    mkdirSync(dirname(again.dbPath), { recursive: true });
    const v1 = new DatabaseSync(again.dbPath);
    v1.exec(MIGRATIONS[0]!);
    v1.exec('PRAGMA user_version = 1');
    v1.exec(`INSERT INTO sessions (id, name, mode, player, status, phase, balance, starting_balance, limits, created_at, updated_at)
             VALUES ('s1', 'old', 'ai', '{"kind":"ollama"}', 'ready', 'ready', 100, 100, '{}', '${T0}', '${T0}')`);
    v1.exec(`INSERT INTO decisions (id, session_id, round_number, epoch, provider_kind, status, validation_errors, attempts, started_at)
             VALUES ('d-old', 's1', 1, 0, 'ollama', 'accepted', '[]', 1, '${T0}')`);
    v1.close();

    const repo = openRepository(again.dbPath);
    cleanups.push(() => repo.close());
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(repo.getDecision('d-old')).toMatchObject({ id: 'd-old', status: 'accepted', providerNote: null });
    expect(repo.updateDecision('d-old', { providerNote: 'Laya top labels: red 0.41' }).providerNote).toBe(
      'Laya top labels: red 0.41',
    );
    const raw = new DatabaseSync(again.dbPath);
    try {
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      const cols = (raw.prepare('PRAGMA table_info(decisions)').all() as { name: string; notnull: number }[]).filter(
        (c) => c.name === 'provider_note',
      );
      expect(cols).toEqual([expect.objectContaining({ name: 'provider_note', notnull: 0 })]);
    } finally {
      raw.close();
    }
  });

  it('accepts every session status/phase value the contracts define', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    for (const status of SCHEMA_ENUMS.sessionStatus) expect(repo.updateSession('s1', { status }).status).toBe(status);
    for (const phase of SCHEMA_ENUMS.sessionPhase) expect(repo.updateSession('s1', { phase }).phase).toBe(phase);
    for (const status of SCHEMA_ENUMS.decisionStatus) {
      repo.insertDecision(decision('s1', `d-${status}`, { status }));
      expect(repo.getDecision(`d-${status}`)?.status).toBe(status);
    }
  });

  it('close() is idempotent', () => {
    const repo = openRepository(':memory:');
    repo.close();
    expect(() => repo.close()).not.toThrow();
  });
});

// ───────────────────────────── sessions ─────────────────────────────

describe('sessions', () => {
  it('createSession sets balance = startingBalance and writes one session_start ledger row', () => {
    const repo = memRepo();
    const s = repo.createSession(newSession('s1', { limits: { ...newSession('x').limits, startingBalance: 12_345 } }));
    expect(s).toMatchObject({
      id: 's1',
      status: 'ready',
      phase: 'ready',
      balance: 12_345,
      startingBalance: 12_345,
      roundsPlayed: 0,
      epoch: 0,
      runtimeMs: 0,
      pauseReason: null,
      endReason: null,
      message: null,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(repo.listLedger('s1')).toEqual([
      { id: expect.any(Number), sessionId: 's1', roundId: null, kind: 'session_start', amount: 12_345, balanceAfter: 12_345, createdAt: T0 },
    ]);
    expectGameError(() => repo.createSession(newSession('s1')), 'duplicate_request');
  });

  it('rejects a fractional starting balance', () => {
    const repo = memRepo();
    expectGameError(
      () => repo.createSession(newSession('s1', { limits: { ...newSession('x').limits, startingBalance: 10.5 } })),
      'validation_error',
    );
    expect(repo.listSessions()).toEqual([]);
  });

  it('never stores server-only fields that ride along on a player config', () => {
    const repo = memRepo();
    const leaky = {
      kind: 'anthropic',
      model: 'user-typed-model',
      apiKey: 'sk-ant-api03-FAKE-FIXTURE-KEY',
      cliPath: 'C:\\secret\\claude.exe',
      useSubscriptionAuth: true,
    } as never;
    const s = repo.createSession(newSession('s1', { mode: 'ai', player: leaky }));
    expect(s.player).toEqual({ kind: 'anthropic', model: 'user-typed-model' });
    const u = repo.updateSession('s1', { player: leaky });
    expect(u.player).toEqual({ kind: 'anthropic', model: 'user-typed-model' });
    expect(JSON.stringify(repo.exportSession('s1'))).not.toContain('sk-ant-api03-FAKE-FIXTURE-KEY');
  });

  it('updateSession applies only patch fields and bumps updatedAt; balance is not patchable', () => {
    const repo = openRepository(':memory:', { now: () => new Date(at(60)) });
    cleanups.push(() => repo.close());
    repo.createSession(newSession('s1'));
    const u = repo.updateSession('s1', {
      status: 'paused',
      pauseReason: 'server_restart',
      message: 'Paused after restart',
      epoch: 3,
      runtimeMs: 1500.5,
      // @ts-expect-error balance is not part of SessionPatch and must be ignored
      balance: 1,
    });
    expect(u).toMatchObject({
      status: 'paused',
      pauseReason: 'server_restart',
      message: 'Paused after restart',
      epoch: 3,
      runtimeMs: 1500.5,
      balance: 100_000,
      updatedAt: at(60),
    });
    expect(repo.updateSession('s1', { pauseReason: null }).pauseReason).toBeNull();
    expectGameError(() => repo.updateSession('missing', { status: 'paused' }), 'not_found');
  });

  it('listSessions is newest first', () => {
    const repo = memRepo();
    repo.createSession(newSession('old', { createdAt: at(0) }));
    repo.createSession(newSession('new', { createdAt: at(10) }));
    expect(repo.listSessions().map((s) => s.id)).toEqual(['new', 'old']);
  });
});

// ───────────────────────────── round lifecycle ─────────────────────────────

describe('commit → outcome → settle', () => {
  it('happy path: stake deducted at commit, returns credited once at settle, ledger sums to balance', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const bets = [redBet(100), straightBet(17, 50), dozenBet(2, 30)];

    const committed = repo.commitRound({
      id: 'r1',
      sessionId: 's1',
      source: 'manual',
      decisionId: null,
      bets,
      idempotencyKey: 'k1',
      committedAt: at(1),
    });
    expect(committed).toMatchObject({
      seq: 1,
      status: 'committed',
      totalStake: 180,
      balanceBefore: 100_000,
      winningNumber: null,
      stakeReturned: null,
      totalReturned: null,
      balanceAfter: null,
      outcomeAt: null,
      settledAt: null,
    });
    expect(committed.bets.map((b) => [b.key, b.won, b.returned])).toEqual([
      ['red', null, null],
      ['straight:17', null, null],
      ['dozen:2', null, null],
    ]);
    expect(committed.bets[2]!.index).toBe(2);
    expect(repo.getSession('s1')!.balance).toBe(100_000 - 180);
    expect(ledgerSum(repo, 's1')).toBe(100_000 - 180);

    const withOutcome = repo.recordOutcome('r1', 17, at(2));
    expect(withOutcome).toMatchObject({ status: 'outcome_recorded', winningNumber: 17, outcomeAt: at(2) });
    // Outcome alone moves no money.
    expect(repo.getSession('s1')!.balance).toBe(100_000 - 180);

    // 17 is black and in the 2nd dozen: straight 50 → 1800, dozen 30 → 90, red loses.
    const settlement = settleFixture(bets, 17);
    expect(settlement).toMatchObject({ stakeReturned: 80, winnings: 1_810, totalReturned: 1_890, net: 1_710 });
    const { round, applied } = repo.settleRound('r1', settlement, at(3));
    expect(applied).toBe(true);
    expect(round).toMatchObject({
      status: 'settled',
      stakeReturned: 80,
      winnings: 1_810,
      totalReturned: 1_890,
      net: 1_710,
      balanceAfter: 100_000 + 1_710,
      settledAt: at(3),
    });
    expect(round.bets.map((b) => [b.key, b.won, b.returned])).toEqual([
      ['red', false, 0],
      ['straight:17', true, 1_800],
      ['dozen:2', true, 90],
    ]);
    const session = repo.getSession('s1')!;
    expect(session.balance).toBe(101_710);
    expect(session.roundsPlayed).toBe(1);
    expect(ledgerSum(repo, 's1')).toBe(session.balance);
    expect(repo.listLedger('s1').map((e) => [e.kind, e.amount, e.balanceAfter])).toEqual([
      ['session_start', 100_000, 100_000],
      ['stake', -180, 99_820],
      ['payout', 1_890, 101_710],
    ]);
  });

  it('keeps ledger sum == balance over many rounds and lists rounds newest first', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const outcomes = [0, 3, 17, 32, 5, 36, 12, 0, 1, 24];
    outcomes.forEach((n, i) => {
      const { applied } = playRound(repo, 's1', `r${i + 1}`, [redBet(110), splitZeroThree(30), straightBet(n, 10)], n, i * 10);
      expect(applied).toBe(true);
      expect(ledgerSum(repo, 's1')).toBe(repo.getSession('s1')!.balance);
    });
    expect(repo.getSession('s1')!.roundsPlayed).toBe(outcomes.length);
    expect(repo.listRounds('s1').map((r) => r.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(repo.listRounds('s1', { limit: 3 }).map((r) => r.seq)).toEqual([10, 9, 8]);
    expect(repo.listRounds('s1', { limit: 2, beforeSeq: 4 }).map((r) => r.seq)).toEqual([3, 2]);
    expect(repo.getLatestRound('s1')!.seq).toBe(10);
    // Every round's recorded balances chain together.
    const rounds = repo.listRounds('s1').reverse();
    rounds.forEach((r, i) => {
      expect(r.balanceAfter).toBe(r.balanceBefore - r.totalStake + r.totalReturned!);
      if (i > 0) expect(r.balanceBefore).toBe(rounds[i - 1]!.balanceAfter);
    });
  });

  it('insufficient funds: throws, writes no rows and leaves the balance unchanged', () => {
    const { repo, raw } = fileRepo('funds');
    repo.createSession(newSession('s1', { limits: { ...newSession('x').limits, startingBalance: 100 } }));
    expectGameError(
      () =>
        repo.commitRound({
          id: 'r1',
          sessionId: 's1',
          source: 'manual',
          decisionId: null,
          bets: [redBet(60), straightBet(1, 50)],
          idempotencyKey: 'k1',
          committedAt: at(1),
        }),
      'insufficient_funds',
    );
    const db = raw();
    expect(count(db, 'SELECT COUNT(*) AS n FROM rounds')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM round_bets')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger WHERE kind <> 'session_start'")).toBe(0);
    expect(repo.getSession('s1')!.balance).toBe(100);
    // Exactly the full balance is still allowed.
    expect(
      repo.commitRound({
        id: 'r1',
        sessionId: 's1',
        source: 'manual',
        decisionId: null,
        bets: [redBet(100)],
        idempotencyKey: 'k1',
        committedAt: at(1),
      }).totalStake,
    ).toBe(100);
    expect(repo.getSession('s1')!.balance).toBe(0);
  });

  it('rolls back the whole commit when a statement fails mid-transaction', () => {
    const { repo, raw } = fileRepo('rollback-commit');
    repo.createSession(newSession('s1'));
    const db = raw();
    // Injected fault: the ledger insert (last write of commitRound) fails.
    db.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON ledger WHEN NEW.kind = 'stake'
             BEGIN SELECT RAISE(ABORT, 'injected fault'); END;`);
    const err = expectGameError(
      () =>
        repo.commitRound({
          id: 'r1',
          sessionId: 's1',
          source: 'manual',
          decisionId: null,
          bets: [redBet(100)],
          idempotencyKey: 'k1',
          committedAt: at(1),
        }),
      'internal',
    );
    expect(String((err.cause as Error).message)).toMatch(/injected fault/);
    expect(count(db, 'SELECT COUNT(*) AS n FROM rounds')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM round_bets')).toBe(0);
    expect(repo.getSession('s1')!.balance).toBe(100_000);
    expect(ledgerSum(repo, 's1')).toBe(100_000);

    // The repository stays usable after a rollback.
    db.exec('DROP TRIGGER inject_fault');
    expect(
      repo.commitRound({
        id: 'r1',
        sessionId: 's1',
        source: 'manual',
        decisionId: null,
        bets: [redBet(100)],
        idempotencyKey: 'k1',
        committedAt: at(1),
      }).status,
    ).toBe('committed');
  });

  it('rolls back the whole settlement when a statement fails mid-transaction', () => {
    const { repo, raw } = fileRepo('rollback-settle');
    repo.createSession(newSession('s1'));
    const bets = [redBet(100)];
    repo.commitRound({ id: 'r1', sessionId: 's1', source: 'manual', decisionId: null, bets, idempotencyKey: null, committedAt: at(1) });
    repo.recordOutcome('r1', 1, at(2));
    const db = raw();
    db.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON ledger WHEN NEW.kind = 'payout'
             BEGIN SELECT RAISE(ABORT, 'injected fault'); END;`);
    expectGameError(() => repo.settleRound('r1', settleFixture(bets, 1), at(3)), 'internal');
    const r = repo.getRound('r1')!;
    expect(r.status).toBe('outcome_recorded');
    expect(r.totalReturned).toBeNull();
    expect(r.bets[0]).toMatchObject({ won: null, returned: null });
    expect(repo.getSession('s1')).toMatchObject({ balance: 99_900, roundsPlayed: 0 });

    db.exec('DROP TRIGGER inject_fault');
    expect(repo.settleRound('r1', settleFixture(bets, 1), at(3)).applied).toBe(true);
    expect(repo.getSession('s1')).toMatchObject({ balance: 100_100, roundsPlayed: 1 });
  });

  it('round_in_progress while the previous round is committed or outcome_recorded', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const commit = (id: string, key: string | null) =>
      repo.commitRound({ id, sessionId: 's1', source: 'demo', decisionId: null, bets: [redBet(10)], idempotencyKey: key, committedAt: at(1) });
    commit('r1', 'k1');
    expectGameError(() => commit('r2', 'k2'), 'round_in_progress');
    repo.recordOutcome('r1', 2, at(2));
    expectGameError(() => commit('r2', 'k2'), 'round_in_progress');
    expect(repo.getSession('s1')!.balance).toBe(99_990);
    repo.settleRound('r1', settleFixture([redBet(10)], 2), at(3));
    expect(commit('r2', 'k2').seq).toBe(2);
  });

  it('idempotent commit replay returns the original round with no second charge', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const input = { id: 'r1', sessionId: 's1', source: 'manual' as const, decisionId: null, bets: [redBet(250)], idempotencyKey: 'same-key', committedAt: at(1) };
    const first = repo.commitRound(input);
    const replay = repo.commitRound({ ...input, id: 'r1-retry', bets: [redBet(990)] });
    expect(replay).toEqual(first);
    expect(repo.getRound('r1-retry')).toBeNull();
    expect(repo.getSession('s1')!.balance).toBe(99_750);
    expect(repo.listLedger('s1').filter((e) => e.kind === 'stake')).toHaveLength(1);
    expect(repo.findRoundByIdempotencyKey('s1', 'same-key')!.id).toBe('r1');
    expect(repo.findRoundByIdempotencyKey('s1', 'other')).toBeNull();

    // Still a replay (not a new round) after the original has been settled.
    repo.recordOutcome('r1', 0, at(2));
    repo.settleRound('r1', settleFixture([redBet(250)], 0), at(3));
    const late = repo.commitRound({ ...input, id: 'r1-late' });
    expect(late.id).toBe('r1');
    expect(late.status).toBe('settled');
    expect(repo.getSession('s1')!.balance).toBe(99_750);
    expect(repo.listRounds('s1')).toHaveLength(1);
  });

  it('rejects duplicate round ids, duplicate bet positions, fractional stakes and unknown decisions', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const base = { sessionId: 's1', source: 'ai' as const, decisionId: null, idempotencyKey: null, committedAt: at(1) };
    expectGameError(() => repo.commitRound({ ...base, id: 'a', bets: [redBet(10), redBet(20)] }), 'invalid_bet');
    expectGameError(() => repo.commitRound({ ...base, id: 'a', bets: [redBet(10.5)] }), 'validation_error');
    expectGameError(() => repo.commitRound({ ...base, id: 'a', bets: [redBet(0)] }), 'validation_error');
    expectGameError(() => repo.commitRound({ ...base, id: 'a', decisionId: 'nope', bets: [redBet(10)] }), 'validation_error');
    expectGameError(() => repo.commitRound({ ...base, id: 'a', sessionId: 'missing', bets: [redBet(10)] }), 'not_found');
    expect(repo.getSession('s1')!.balance).toBe(100_000);

    repo.insertDecision(decision('s1', 'd1', { status: 'accepted', action: 'bet' }));
    expect(repo.commitRound({ ...base, id: 'a', decisionId: 'd1', bets: [redBet(10)] }).decisionId).toBe('d1');
    repo.recordOutcome('a', 1, at(2));
    repo.settleRound('a', settleFixture([redBet(10)], 1), at(3));
    expectGameError(() => repo.commitRound({ ...base, id: 'a', bets: [redBet(10)] }), 'duplicate_request');
  });

  it('recordOutcome never overwrites an existing outcome and validates 0..36', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    repo.commitRound({ id: 'r1', sessionId: 's1', source: 'manual', decisionId: null, bets: [redBet(10)], idempotencyKey: null, committedAt: at(1) });
    for (const bad of [-1, 37, 1.5, Number.NaN]) {
      expectGameError(() => repo.recordOutcome('r1', bad, at(2)), 'validation_error');
    }
    expect(repo.getRound('r1')!.status).toBe('committed');
    const first = repo.recordOutcome('r1', 7, at(2));
    const again = repo.recordOutcome('r1', 8, at(9));
    expect(again).toEqual(first);
    expect(again).toMatchObject({ winningNumber: 7, outcomeAt: at(2) });
    repo.settleRound('r1', settleFixture([redBet(10)], 7), at(3));
    expect(repo.recordOutcome('r1', 30, at(10)).winningNumber).toBe(7);
    expectGameError(() => repo.recordOutcome('missing', 1, at(2)), 'not_found');
  });

  it('settleRound twice → applied:false, a single payout row and an unchanged balance', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const bets = [straightBet(0, 100)];
    playRound(repo, 's1', 'r1', bets, 0);
    const before = { session: repo.getSession('s1'), ledger: repo.listLedger('s1'), round: repo.getRound('r1') };
    const second = repo.settleRound('r1', settleFixture(bets, 0), at(99));
    expect(second.applied).toBe(false);
    expect(second.round).toEqual(before.round);
    expect(repo.getSession('s1')).toEqual(before.session);
    expect(repo.listLedger('s1')).toEqual(before.ledger);
    expect(repo.listLedger('s1').filter((e) => e.kind === 'payout')).toHaveLength(1);
    expect(repo.getSession('s1')).toMatchObject({ balance: 100_000 + 3_500, roundsPlayed: 1 });
  });

  it('rejects settlement before an outcome, with a mismatched number, or with tampered amounts', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const bets = [redBet(100), splitZeroThree(50)];
    repo.commitRound({ id: 'r1', sessionId: 's1', source: 'manual', decisionId: null, bets, idempotencyKey: null, committedAt: at(1) });
    expectGameError(() => repo.settleRound('r1', settleFixture(bets, 3), at(2)), 'invalid_state');
    repo.recordOutcome('r1', 3, at(2));

    expectGameError(() => repo.settleRound('r1', settleFixture(bets, 5), at(3)), 'invalid_state');

    const good = settleFixture(bets, 3);
    const tampered = [
      { ...good, totalReturned: good.totalReturned + 100, winnings: good.winnings + 100, net: good.net + 100 },
      { ...good, bets: good.bets.map((b) => (b.key === 'red' ? { ...b, returned: b.returned + 1 } : b)) },
      { ...good, bets: good.bets.slice(1) },
      { ...good, bets: good.bets.map((b) => (b.key === 'red' ? { ...b, key: 'black' } : b)) },
      { ...good, totalStake: 1 },
      { ...good, net: good.net + 1 },
    ];
    for (const s of tampered) expectGameError(() => repo.settleRound('r1', s, at(3)), 'internal');
    expect(repo.getRound('r1')!.status).toBe('outcome_recorded');
    expect(repo.getSession('s1')).toMatchObject({ balance: 99_850, roundsPlayed: 0 });

    expect(repo.settleRound('r1', good, at(3)).applied).toBe(true);
    // 3 is red and in split 0/3: red 100 → 200, split 50 → 900.
    expect(repo.getSession('s1')).toMatchObject({ balance: 99_850 + 1_100, roundsPlayed: 1 });
    expectGameError(() => repo.settleRound('missing', good, at(3)), 'not_found');
  });

  it('supports an empty (no-bet) round: no stake row, a 0 payout row, roundsPlayed++', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    const r = repo.commitRound({ id: 'r1', sessionId: 's1', source: 'ai', decisionId: null, bets: [], idempotencyKey: 'skip-1', committedAt: at(1) });
    expect(r).toMatchObject({ totalStake: 0, bets: [], balanceBefore: 100_000 });
    expect(repo.listLedger('s1').filter((e) => e.kind === 'stake')).toHaveLength(0);
    repo.recordOutcome('r1', 19, at(2));
    const { round, applied } = repo.settleRound('r1', settleFixture([], 19), at(3));
    expect(applied).toBe(true);
    expect(round).toMatchObject({ status: 'settled', totalReturned: 0, net: 0, balanceAfter: 100_000 });
    expect(repo.listLedger('s1').filter((e) => e.kind === 'payout').map((e) => e.amount)).toEqual([0]);
    expect(repo.getSession('s1')).toMatchObject({ balance: 100_000, roundsPlayed: 1 });
  });
});

// ───────────────────────────── storage-level guarantees ─────────────────────────────

describe('database constraints (raw connection bypassing the repository)', () => {
  it('CHECK(balance >= 0) is enforced', () => {
    const { repo, raw } = fileRepo('check-balance');
    repo.createSession(newSession('s1'));
    const db = raw();
    expect(() => db.prepare('UPDATE sessions SET balance = -1 WHERE id = ?').run('s1')).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare('UPDATE sessions SET balance = 10.5 WHERE id = ?').run('s1')).toThrow(/REAL value in INTEGER column/);
    expect(repo.getSession('s1')!.balance).toBe(100_000);
  });

  it('outcomes are immutable, settled rounds are frozen, the ledger is append-only', () => {
    const { repo, raw } = fileRepo('triggers');
    repo.createSession(newSession('s1'));
    playRound(repo, 's1', 'r1', [redBet(10)], 1);
    repo.commitRound({ id: 'r2', sessionId: 's1', source: 'manual', decisionId: null, bets: [redBet(10)], idempotencyKey: null, committedAt: at(5) });
    repo.recordOutcome('r2', 4, at(6));
    const db = raw();
    expect(() => db.prepare('UPDATE rounds SET winning_number = 5 WHERE id = ?').run('r2')).toThrow(/never replaced/);
    expect(() => db.prepare("UPDATE rounds SET status = 'committed' WHERE id = ?").run('r2')).toThrow(/status transition/);
    expect(() => db.prepare('UPDATE rounds SET settled_at = ? WHERE id = ?').run(at(9), 'r1')).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE ledger SET amount = 1').run()).toThrow(/append-only/);
    expect(() =>
      db.prepare("INSERT INTO ledger (session_id, round_id, kind, amount, balance_after, created_at) VALUES ('s1','r1','payout',5,5,'x')").run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO rounds (id, session_id, seq, status, source, total_stake, balance_before, committed_at) VALUES ('r3','s1',3,'committed','manual',0,0,'x')",
        )
        .run(),
    ).toThrow(/UNIQUE/); // second open round in the same session
    expect(repo.getRound('r2')!.winningNumber).toBe(4);
  });
});

// ───────────────────────────── persistence & recovery ─────────────────────────────

describe('persistence across close/reopen', () => {
  it('keeps sessions, rounds, ledger, decisions, usage, logs, settings and idempotency', () => {
    const tmp = tmpDir('persist');
    cleanups.push(tmp.cleanup);
    const a = openRepository(tmp.dbPath);
    a.createSession(newSession('s1', { mode: 'ai', player: { kind: 'ollama', model: 'fixture-model', baseUrl: 'http://127.0.0.1:11434' } }));
    a.insertDecision(decision('s1', 'd1', { status: 'accepted', action: 'bet', bets: [{ type: 'red', stake: 100 }], explanation: 'fixture' }));
    a.insertUsage(usage('s1', 'd1', 'u1'));
    playRound(a, 's1', 'r1', [redBet(100)], 1);
    a.appendLog('s1', 'info', 'round', 'Round 1 settled');
    a.putSetting('app', { animationSpeed: 'fast' });
    a.putIdempotent('control', 'key-1', { ok: true });
    const snapshot = { ...a.exportSession('s1'), exportedAt: 'x' };
    a.close();

    const b = openRepository(tmp.dbPath);
    expect({ ...b.exportSession('s1'), exportedAt: 'x' }).toEqual(snapshot);
    expect(b.getSetting('app')).toEqual({ animationSpeed: 'fast' });
    expect(b.getIdempotent('control', 'key-1')).toEqual({ ok: true });
    expect(b.getSession('s1')!.balance).toBe(100_100);
    b.close();
  });
});

describe('startup recovery queries', () => {
  it('findUnsettledRounds / findPendingDecisions across sessions after a crash (second connection, first never closed)', () => {
    const tmp = tmpDir('crash-inproc');
    const crashed = openRepository(tmp.dbPath);
    crashed.createSession(newSession('a', { createdAt: at(0) }));
    crashed.createSession(newSession('b', { createdAt: at(1) }));
    crashed.createSession(newSession('c', { createdAt: at(2) }));
    // a: committed only; b: committed + outcome; c: fully settled.
    crashed.commitRound({ id: 'ra', sessionId: 'a', source: 'demo', decisionId: null, bets: [redBet(100)], idempotencyKey: null, committedAt: at(10) });
    crashed.commitRound({ id: 'rb', sessionId: 'b', source: 'demo', decisionId: null, bets: [straightBet(9, 100)], idempotencyKey: null, committedAt: at(11) });
    crashed.recordOutcome('rb', 9, at(12));
    playRound(crashed, 'c', 'rc', [redBet(100)], 2, 20);
    crashed.insertDecision(decision('a', 'pending-a', { status: 'pending', startedAt: at(30) }));
    crashed.insertDecision(decision('c', 'done-c', { status: 'accepted', startedAt: at(31) }));

    const recovered = openRepository(tmp.dbPath);
    cleanups.push(() => {
      recovered.close();
      crashed.close();
      tmp.cleanup();
    });
    const open = recovered.findUnsettledRounds();
    expect(open.map((r) => [r.id, r.status, r.winningNumber])).toEqual([
      ['ra', 'committed', null],
      ['rb', 'outcome_recorded', 9],
    ]);
    expect(recovered.findPendingDecisions().map((d) => d.id)).toEqual(['pending-a']);

    // Recovery settles without redrawing: the stored outcome wins over a new draw.
    expect(recovered.recordOutcome('rb', 30, at(40)).winningNumber).toBe(9);
    expect(recovered.settleRound('rb', settleFixture([straightBet(9, 100)], 9), at(41)).applied).toBe(true);
    recovered.recordOutcome('ra', 5, at(42));
    expect(recovered.settleRound('ra', settleFixture([redBet(100)], 5), at(43)).applied).toBe(true);
    expect(recovered.findUnsettledRounds()).toEqual([]);
    for (const id of ['a', 'b', 'c']) expect(ledgerSum(recovered, id)).toBe(recovered.getSession(id)!.balance);
    expect(recovered.getSession('b')!.balance).toBe(100_000 - 100 + 3_600);
  });
});

// ───────────────────────────── decisions, usage, logs, settings, idempotency ─────────────────────────────

describe('decisions', () => {
  it('insert/get/update/list newest first; update never changes id or session', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    repo.createSession(newSession('s2'));
    repo.insertDecision(decision('s1', 'd1', { startedAt: at(1) }));
    repo.insertDecision(decision('s1', 'd2', { startedAt: at(2), roundNumber: 2 }));
    repo.insertDecision(decision('s2', 'd3', { startedAt: at(3) }));
    expectGameError(() => repo.insertDecision(decision('s1', 'd1')), 'duplicate_request');
    expectGameError(() => repo.insertDecision(decision('nope', 'd9')), 'not_found');

    const updated = repo.updateDecision('d1', {
      id: 'hijack',
      sessionId: 's2',
      status: 'invalid',
      rawOutput: '{"action":"bet","bets":[{"type":"purple"}]}',
      validationErrors: ['unknown bet type "purple"'],
      errorCode: 'invalid_output',
      attempts: 3,
      completedAt: at(5),
      latencyMs: 812.75,
      explanation: undefined,
    });
    expect(updated).toMatchObject({
      id: 'd1',
      sessionId: 's1',
      status: 'invalid',
      validationErrors: ['unknown bet type "purple"'],
      attempts: 3,
      latencyMs: 812.75,
      explanation: null,
    });
    expect(repo.getDecision('hijack')).toBeNull();
    expect(repo.listDecisions('s1').map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(repo.listDecisions('s1', 1).map((d) => d.id)).toEqual(['d2']);
    expect(repo.findPendingDecisions().map((d) => d.id)).toEqual(['d2', 'd3']);
    expectGameError(() => repo.updateDecision('missing', { status: 'failed' }), 'not_found');
  });
});

describe('usage, logs, settings, idempotency', () => {
  it('usage round-trips exactly (null = unknown, fractional estimates kept) oldest first', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    repo.insertDecision(decision('s1', 'd1'));
    const u1 = usage('s1', 'd1', 'u1', { createdAt: at(2) });
    const u2 = usage('s1', 'd1', 'u2', {
      attempt: 2,
      status: 'timeout',
      known: false,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      generationMs: null,
      outputTokensPerSec: null,
      costMicros: 12.5,
      costBasis: 'estimated-from-pricing',
      rateLimit: { source: 'response-headers', capturedAt: at(3), entries: [{ name: 'requests', limit: 50, remaining: 49 }] },
      createdAt: at(3),
    });
    repo.insertUsage(u2);
    repo.insertUsage(u1);
    expect(repo.listUsage('s1')).toEqual([u1, u2]);
    expectGameError(() => repo.insertUsage(u1), 'duplicate_request');
  });

  it('logs are newest first with a limit', () => {
    const repo = openRepository(':memory:', { now: () => new Date(T0) });
    cleanups.push(() => repo.close());
    const l1 = repo.appendLog('s1', 'info', 'session', 'created');
    const l2 = repo.appendLog('s1', 'warn', 'provider', 'rate limited');
    repo.appendLog('s2', 'error', 'provider', 'other session');
    expect(l1).toEqual({ id: l1.id, sessionId: 's1', level: 'info', type: 'session', message: 'created', createdAt: T0 });
    expect(l2.id).toBeGreaterThan(l1.id);
    expect(repo.listLogs('s1').map((l) => l.message)).toEqual(['rate limited', 'created']);
    expect(repo.listLogs('s1', 1)).toEqual([l2]);
  });

  it('settings are JSON values; idempotency keeps the first response per (scope, key)', () => {
    const repo = memRepo();
    expect(repo.getSetting('app')).toBeNull();
    repo.putSetting('app', { animationSpeed: 'normal', pricing: {} });
    repo.putSetting('app', { animationSpeed: 'instant', pricing: {} });
    expect(repo.getSetting('app')).toEqual({ animationSpeed: 'instant', pricing: {} });

    expect(repo.getIdempotent('create', 'k')).toBeNull();
    repo.putIdempotent('create', 'k', { session: { id: 's1' } });
    repo.putIdempotent('create', 'k', { session: { id: 's2' } });
    repo.putIdempotent('control', 'k', { action: 'start' });
    expect(repo.getIdempotent('create', 'k')).toEqual({ session: { id: 's1' } });
    expect(repo.getIdempotent('control', 'k')).toEqual({ action: 'start' });
  });
});

// ───────────────────────────── audit fixes: idempotent create, overflow, provider notes ─────────────────────────────

describe('createSessionIdempotent (session + ledger + idempotency record in ONE transaction)', () => {
  const idem = (key: string, fingerprint = 'fp-1') => ({ scope: 'create-session', key, fingerprint });

  it('creates the session, its session_start ledger row and the record { sessionId, fingerprint }', () => {
    const repo = memRepo();
    const res = repo.createSessionIdempotent(newSession('s1'), idem('k1'));
    expect(res.created).toBe(true);
    expect(res.fingerprint).toBe('fp-1');
    expect(res.session).toMatchObject({ id: 's1', balance: 100_000, status: 'ready' });
    expect(repo.listLedger('s1').map((e) => e.kind)).toEqual(['session_start']);
    expect(repo.getIdempotent('create-session', 'k1')).toEqual({ sessionId: 's1', fingerprint: 'fp-1' });
  });

  it('replay: an existing key writes nothing and returns the ORIGINAL session and STORED fingerprint', () => {
    const repo = memRepo();
    const first = repo.createSessionIdempotent(newSession('s1'), idem('k1', 'fp-original'));
    const replay = repo.createSessionIdempotent(newSession('s2', { name: 'different body' }), idem('k1', 'fp-other'));
    expect(replay).toEqual({ session: first.session, created: false, fingerprint: 'fp-original' });
    expect(repo.getSession('s2')).toBeNull();
    expect(repo.listSessions().map((s) => s.id)).toEqual(['s1']);
    expect(repo.listLedger('s1')).toHaveLength(1);
    expect(repo.getIdempotent('create-session', 'k1')).toEqual({ sessionId: 's1', fingerprint: 'fp-original' });
    // The same key in another scope is independent.
    expect(repo.createSessionIdempotent(newSession('s3'), { ...idem('k1'), scope: 'other-scope' }).created).toBe(true);
  });

  it('concurrent-style double call from two connections to one file: exactly one session is created', () => {
    const { repo: a, dbPath } = fileRepo('idem-two-conns');
    const b = openRepository(dbPath);
    cleanups.push(() => b.close());
    const fromA = a.createSessionIdempotent(newSession('from-a'), idem('same-key', 'fp-a'));
    const fromB = b.createSessionIdempotent(newSession('from-b'), idem('same-key', 'fp-b'));
    expect(fromA.created).toBe(true);
    expect(fromB).toMatchObject({ created: false, fingerprint: 'fp-a', session: { id: 'from-a' } });
    expect(b.listSessions().map((s) => s.id)).toEqual(['from-a']);
    expect(a.getSession('from-b')).toBeNull();
  });

  it('is atomic: if the idempotency write fails, the session and its ledger row are rolled back', () => {
    const { repo, raw } = fileRepo('idem-atomic');
    const db = raw();
    db.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON idempotency
             BEGIN SELECT RAISE(ABORT, 'injected fault'); END;`);
    expectGameError(() => repo.createSessionIdempotent(newSession('s1'), idem('k1')), 'internal');
    expect(repo.getSession('s1')).toBeNull();
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(0);
    db.exec('DROP TRIGGER inject_fault');
    // A retry with the same key now succeeds exactly once.
    expect(repo.createSessionIdempotent(newSession('s1'), idem('k1')).created).toBe(true);
    expect(repo.createSessionIdempotent(newSession('s1-retry'), idem('k1')).created).toBe(false);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions')).toBe(1);
  });

  it('a duplicate session id under a NEW key fails without writing the key', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    expectGameError(() => repo.createSessionIdempotent(newSession('s1'), idem('fresh')), 'duplicate_request');
    expect(repo.getIdempotent('create-session', 'fresh')).toBeNull();
  });

  it('accepts records written before fingerprints existed; refuses a record whose session is missing', () => {
    const repo = memRepo();
    repo.createSession(newSession('legacy'));
    repo.putIdempotent('create-session', 'old-key', { sessionId: 'legacy' });
    expect(repo.createSessionIdempotent(newSession('s2'), idem('old-key', 'fp-now'))).toMatchObject({
      created: false,
      fingerprint: 'fp-now',
      session: { id: 'legacy' },
    });
    repo.putIdempotent('create-session', 'dangling', { sessionId: 'gone' });
    expectGameError(() => repo.createSessionIdempotent(newSession('s3'), idem('dangling')), 'internal');
    expect(repo.getSession('s3')).toBeNull();
  });

  it('validates its arguments before touching the database', () => {
    const repo = memRepo();
    expectGameError(() => repo.createSessionIdempotent(newSession('s1'), { scope: '', key: 'k', fingerprint: 'f' }), 'validation_error');
    expectGameError(() => repo.createSessionIdempotent(newSession('s1'), { scope: 's', key: '', fingerprint: 'f' }), 'validation_error');
    expectGameError(
      () => repo.createSessionIdempotent(newSession('s1'), { scope: 's', key: 'k', fingerprint: undefined as never }),
      'validation_error',
    );
    expect(repo.listSessions()).toEqual([]);
  });
});

describe('balances near Number.MAX_SAFE_INTEGER', () => {
  it('commitRound refuses a bet slip whose best possible win could not be credited exactly (no charge, no round)', () => {
    const repo = memRepo();
    const huge = Number.MAX_SAFE_INTEGER - 1_000;
    repo.createSession(newSession('s1', { limits: { ...newSession('x').limits, startingBalance: huge } }));
    const err = expectGameError(
      () =>
        repo.commitRound({
          id: 'r1',
          sessionId: 's1',
          source: 'manual',
          decisionId: null,
          bets: [straightBet(7, 100)], // could return 3 600 > 1 000 headroom
          idempotencyKey: 'k1',
          committedAt: at(1),
        }),
      'limit_exceeded',
    );
    expect(err.message).toMatch(/largest balance/);
    expect(repo.getRound('r1')).toBeNull();
    expect(repo.getSession('s1')!.balance).toBe(huge);
    // A slip that fits in the headroom is still accepted and settles.
    const { applied, round } = playRound(repo, 's1', 'r2', [straightBet(7, 10)], 7); // returns 360
    expect(applied).toBe(true);
    expect(round.balanceAfter).toBe(huge + 350);
  });

  it('a settlement that would overflow the balance is an INTERNAL error (HTTP 500), not a 400, and changes nothing', () => {
    const { repo, raw } = fileRepo('overflow-settle');
    repo.createSession(newSession('s1'));
    const bets = [straightBet(7, 100)];
    repo.commitRound({ id: 'r1', sessionId: 's1', source: 'manual', decisionId: null, bets, idempotencyKey: 'k1', committedAt: at(1) });
    repo.recordOutcome('r1', 7, at(2));
    // Simulate a balance that grew out of range after commit (bypassing the commit-time guard).
    const db = raw();
    db.prepare('UPDATE sessions SET balance = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER - 10, 's1');
    const err = expectGameError(() => repo.settleRound('r1', settleFixture(bets, 7), at(3)), 'internal');
    expect(HTTP_STATUS_FOR[err.code]).toBe(500);
    expect(repo.getRound('r1')!.status).toBe('outcome_recorded');
    expect(repo.getSession('s1')).toMatchObject({ balance: Number.MAX_SAFE_INTEGER - 10, roundsPlayed: 0 });
    expect(repo.listLedger('s1').filter((e) => e.kind === 'payout')).toHaveLength(0);
  });
});

describe('decision provider notes', () => {
  it('insert/update/read round-trip providerNote; absent means null', () => {
    const repo = memRepo();
    repo.createSession(newSession('s1'));
    repo.insertDecision(decision('s1', 'd1', { providerNote: 'Claude Code CLI conversation abc: turn 2 (resumed)' }));
    const { providerNote: _omit, ...withoutNote } = decision('s1', 'd2', { startedAt: at(5) });
    repo.insertDecision(withoutNote);
    expect(repo.getDecision('d1')!.providerNote).toBe('Claude Code CLI conversation abc: turn 2 (resumed)');
    expect(repo.getDecision('d2')!.providerNote).toBeNull();

    // A patch without providerNote keeps it; null clears it; a string sets it.
    expect(repo.updateDecision('d1', { status: 'accepted' }).providerNote).toBe('Claude Code CLI conversation abc: turn 2 (resumed)');
    expect(repo.updateDecision('d1', { providerNote: null }).providerNote).toBeNull();
    expect(repo.updateDecision('d2', { providerNote: 'Laya top labels: red 0.41, black 0.38 (routing: colour)' }).providerNote).toBe(
      'Laya top labels: red 0.41, black 0.38 (routing: colour)',
    );
    expect(repo.listDecisions('s1').map((d) => [d.id, d.providerNote])).toEqual([
      ['d2', 'Laya top labels: red 0.41, black 0.38 (routing: colour)'],
      ['d1', null],
    ]);
    expect(repo.exportSession('s1').decisions.map((d) => d.providerNote)).toEqual([
      null,
      'Laya top labels: red 0.41, black 0.38 (routing: colour)',
    ]);
  });
});
