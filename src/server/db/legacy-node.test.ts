/**
 * Regression test for audit #1: node:sqlite before Node 22.16 has no DatabaseSync#isTransaction
 * (and before 22.15 no #isOpen). The repository must track its own transaction state, so it
 * keeps working when those properties are missing.
 *
 * node:sqlite is mocked with a wrapper whose instances report `isTransaction` and `isOpen` as
 * undefined (the real properties are non-configurable, so a Proxy hides them). Every SQL call
 * still goes to the real DatabaseSync.
 */
import { DatabaseSync as RealDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:sqlite', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:sqlite')>();
  const Real = mod.DatabaseSync;
  const HIDDEN = new Set<PropertyKey>(['isTransaction', 'isOpen']);
  class LegacyDatabaseSync {
    constructor(...args: ConstructorParameters<typeof Real>) {
      const real = new Real(...args);
      return new Proxy(real, {
        get(target, key) {
          if (HIDDEN.has(key)) return undefined;
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    }
  }
  return { ...mod, DatabaseSync: LegacyDatabaseSync, default: { ...mod, DatabaseSync: LegacyDatabaseSync } };
});

import { GameError } from '../../shared/contracts.js';
import type { Repository } from '../types.js';
import { at, newSession, playRound, redBet, settleFixture, tmpDir } from './__tests__/fixtures.js';
import { toCsvExport, toJsonExport } from './export.js';
import { openRepository } from './sqlite.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fileRepo(label: string) {
  const tmp = tmpDir(label);
  const opened: Repository[] = [];
  const open = () => {
    const repo = openRepository(tmp.dbPath, { appVersion: '9.9.9-legacy' });
    opened.push(repo);
    return repo;
  };
  cleanups.push(() => {
    for (const r of opened) r.close();
    tmp.cleanup();
  });
  return { open, dbPath: tmp.dbPath };
}

/** Read a table with a separate, unmocked connection (sees only COMMITTED data). */
function committedCount(dbPath: string, sql: string): number {
  const db = new RealDatabaseSync(dbPath);
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('repository without DatabaseSync#isTransaction / #isOpen (Node 22.13–22.15)', () => {
  it('the mock really hides the properties', () => {
    const { open } = fileRepo('legacy-mock');
    const repo = open();
    const db = (repo as unknown as { db: { isTransaction: unknown; isOpen: unknown } }).db;
    expect(db.isTransaction).toBeUndefined();
    expect(db.isOpen).toBeUndefined();
  });

  it('commit → export → commit → settings put → restart keeps working and persists everything', () => {
    const { open, dbPath } = fileRepo('legacy-flow');
    let repo = open();
    repo.createSession(newSession('s1'));
    playRound(repo, 's1', 'r1', [redBet(100)], 1, 0); // 1 is red: +100

    // Export runs in a read snapshot; it must COMMIT (end) that snapshot.
    const exported = repo.exportSession('s1');
    expect(exported.rounds).toHaveLength(1);
    expect(exported.app.version).toBe('9.9.9-legacy');
    expect(toJsonExport(exported)).toContain('"r1"');
    expect(toCsvExport(exported)).toContain('Red 1.00');

    // The next round must not fail with "cannot start a transaction within a transaction".
    const r2 = repo.commitRound({
      id: 'r2',
      sessionId: 's1',
      source: 'manual',
      decisionId: null,
      bets: [redBet(50)],
      idempotencyKey: 'k2',
      committedAt: at(10),
    });
    expect(r2.status).toBe('committed');
    repo.recordOutcome('r2', 2, at(11)); // 2 is black: -50
    expect(repo.settleRound('r2', settleFixture([redBet(50)], 2), at(12)).applied).toBe(true);

    // A second export, then a settings write outside any repository transaction.
    expect(repo.exportSession('s1').rounds).toHaveLength(2);
    repo.putSetting('app', { animationSpeed: 'fast', roundPacingMs: 1234 });

    // Another connection sees the writes as COMMITTED (not stuck inside an open transaction).
    expect(committedCount(dbPath, 'SELECT COUNT(*) AS n FROM rounds')).toBe(2);
    expect(committedCount(dbPath, "SELECT COUNT(*) AS n FROM settings WHERE key = 'app'")).toBe(1);

    repo.close();
    expect(() => repo.close()).not.toThrow();

    repo = open();
    expect(repo.getSetting('app')).toEqual({ animationSpeed: 'fast', roundPacingMs: 1234 });
    expect(repo.getSession('s1')).toMatchObject({ balance: 100_000 + 100 - 50, roundsPlayed: 2 });
  });

  it('a failed transaction always rolls back, so the next one can start', () => {
    const { open, dbPath } = fileRepo('legacy-rollback');
    const repo = open();
    repo.createSession(newSession('s1', { limits: { ...newSession('x').limits, startingBalance: 100 } }));
    const commit = (id: string, stake: number) =>
      repo.commitRound({ id, sessionId: 's1', source: 'manual', decisionId: null, bets: [redBet(stake)], idempotencyKey: id, committedAt: at(1) });

    // GameError thrown inside the transaction body.
    expect(() => commit('too-much', 101)).toThrow(GameError);
    // A failed export (unknown session) inside a read snapshot.
    expect(() => repo.exportSession('missing')).toThrow(GameError);

    expect(commit('ok', 100).status).toBe('committed');
    repo.putSetting('after-failures', true);
    expect(committedCount(dbPath, 'SELECT COUNT(*) AS n FROM rounds')).toBe(1);
    expect(committedCount(dbPath, "SELECT COUNT(*) AS n FROM settings WHERE key = 'after-failures'")).toBe(1);
  });
});
