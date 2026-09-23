/**
 * E2E — manual session over HTTP (real app + service + SQLite file DB; FIXTURE outcome sequence).
 *
 * Proves: hand-computed settlement per round (stakeReturned / winnings / net / balances), the ledger and
 * the JSON export agree with the balance, the CSV export has the round columns, rejected bets are 422
 * ApiErrorBody with no side effects, and Idempotency-Key replays / concurrent submissions never
 * double-charge or double-settle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetInput, ManualRoundResponse, RoundRecord, SessionSnapshot } from '../../src/shared/contracts.js';
import { colorOf } from '../../src/shared/roulette.js';
import type { SessionExport } from '../../src/server/types.js';
import {
  FAKE_SECRET,
  bet,
  createHarness,
  createSession,
  errorBody,
  expectOk,
  ledgerSum,
  moneyCellEquals,
  normHeader,
  parseCsv,
  snapshot,
  type Harness,
} from './harness.js';

/**
 * Hand-computed script. Start balance 1,000.00 credits = 100_000 subunits.
 * Payouts: straight 35:1, split 17:1, corner 8:1, dozen 2:1, red 1:1. Zero loses every outside bet.
 */
interface Expected {
  bets: BetInput[];
  outcome: number;
  totalStake: number;
  stakeReturned: number;
  winnings: number;
  totalReturned: number;
  net: number;
  balanceAfter: number;
  /** returned per bet, in submission order */
  perBet: number[];
}

const SCRIPT: Expected[] = [
  {
    // straight 17 @1.30 → 17 wins: 130 back + 35×130 = 4550
    bets: [bet('straight', 130, { numbers: [17] })],
    outcome: 17,
    totalStake: 130,
    stakeReturned: 130,
    winnings: 4550,
    totalReturned: 4680,
    net: 4550,
    balanceAfter: 104_550,
    perBet: [4680],
  },
  {
    // split with zero given in reverse order (0/3) @2.00 → 0 wins: 200 back + 17×200 = 3400
    bets: [bet('split', 200, { numbers: [3, 0] })],
    outcome: 0,
    totalStake: 200,
    stakeReturned: 200,
    winnings: 3400,
    totalReturned: 3600,
    net: 3400,
    balanceAfter: 107_950,
    perBet: [3600],
  },
  {
    // corner 1/2/4/5 @0.50 wins (50+400), dozen 2 @3.00 loses, red @1.50 wins (150+150) on 5 (red)
    bets: [
      bet('corner', 50, { numbers: [1, 2, 4, 5] }),
      bet('dozen', 300, { index: 2 }),
      bet('red', 150),
    ],
    outcome: 5,
    totalStake: 500,
    stakeReturned: 200,
    winnings: 550,
    totalReturned: 750,
    net: 250,
    balanceAfter: 108_200,
    perBet: [450, 0, 300],
  },
  {
    // zero: dozen and red both lose (no la partage)
    bets: [bet('dozen', 1000, { index: 2 }), bet('red', 500)],
    outcome: 0,
    totalStake: 1500,
    stakeReturned: 0,
    winnings: 0,
    totalReturned: 0,
    net: -1500,
    balanceAfter: 106_700,
    perBet: [0, 0],
  },
  {
    // 20 is black and in the 2nd dozen: dozen wins (250+500); red and straight 0 @0.10 lose
    bets: [bet('dozen', 250, { index: 2 }), bet('red', 250), bet('straight', 10, { numbers: [0] })],
    outcome: 20,
    totalStake: 510,
    stakeReturned: 250,
    winnings: 500,
    totalReturned: 750,
    net: 240,
    balanceAfter: 106_940,
    perBet: [750, 0, 0],
  },
];

const START = 100_000;
// Outcomes after the script feed the idempotency / concurrency rounds (all lose for red @1.00 on black 2/4/6).
const OUTCOMES = [...SCRIPT.map((s) => s.outcome), 2, 4, 6, 8, 10, 11, 13, 15];

describe('E2E manual session (FIXTURE outcome sequence)', () => {
  let h: Harness;
  let sessionId: string;
  const played: RoundRecord[] = [];

  beforeAll(async () => {
    h = await createHarness({ label: 'manual', outcomes: OUTCOMES });
  });

  afterAll(async () => {
    // Blanket check over EVERY response this suite received: the configured API key never leaks.
    for (const r of h?.transcript ?? []) expect(r.body.includes(FAKE_SECRET), `${r.method} ${r.url}`).toBe(false);
    await h?.close({ removeDb: true });
  });

  it('creates a manual session; replaying the create Idempotency-Key returns the same session', async () => {
    const key = crypto.randomUUID();
    const snap = await createSession(h, { name: 'e2e manual', player: { kind: 'manual' } }, key);
    sessionId = snap.session.id;
    expect(snap.session.mode).toBe('manual');
    expect(snap.session.balance).toBe(START);
    expect(snap.session.startingBalance).toBe(START);
    expect(snap.session.roundsPlayed).toBe(0);

    const again = await createSession(h, { name: 'e2e manual', player: { kind: 'manual' } }, key);
    expect(again.session.id).toBe(sessionId);
    const list = expectOk(await h.api<{ sessions: { id: string }[] }>('GET', '/api/sessions'), 'list');
    expect(list.sessions.filter((s) => s.id === sessionId)).toHaveLength(1);
    expect(list.sessions).toHaveLength(1);
  });

  it('settles five scripted rounds exactly as hand-computed', async () => {
    let balance = START;
    for (const [i, exp] of SCRIPT.entries()) {
      const res = await h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, {
        body: { bets: exp.bets },
      });
      const { round, snapshot: snap } = expectOk(res, `round ${i + 1}`);
      played.push(round);

      expect(round.seq).toBe(i + 1);
      expect(round.status).toBe('settled');
      expect(round.source).toBe('manual');
      expect(round.winningNumber).toBe(exp.outcome);
      expect(round.balanceBefore).toBe(balance);
      expect(round.totalStake).toBe(exp.totalStake);
      expect(round.stakeReturned).toBe(exp.stakeReturned);
      expect(round.winnings).toBe(exp.winnings);
      expect(round.totalReturned).toBe(exp.totalReturned);
      expect(round.net).toBe(exp.net);
      expect(round.balanceAfter).toBe(exp.balanceAfter);
      expect(round.settledAt).toBeTruthy();
      // per-bet results (matched by covered numbers/type, independent of server ordering)
      expect(round.bets).toHaveLength(exp.bets.length);
      exp.bets.forEach((b, j) => {
        const numbers = b.numbers ? [...b.numbers].sort((x, y) => x - y) : undefined;
        const match = round.bets.find(
          (rb) => rb.type === b.type && rb.stake === b.stake && (numbers ? rb.numbers.join() === numbers.join() : rb.index === b.index),
        );
        expect(match, `bet ${j} of round ${i + 1}`).toBeDefined();
        expect(match!.returned).toBe(exp.perBet[j]);
        expect(match!.won).toBe(exp.perBet[j]! > 0);
      });

      expect(snap.session.balance).toBe(exp.balanceAfter);
      expect(snap.session.roundsPlayed).toBe(i + 1);
      balance = exp.balanceAfter;
    }
    // Canonical keys documented in contracts.ts.
    expect(played[0]!.bets[0]!.key).toBe('straight:17');
    expect(played[1]!.bets[0]!.key).toBe('split:0-3');
    expect(played[1]!.bets[0]!.numbers).toEqual([0, 3]);
    expect(played[2]!.bets.map((b) => b.key)).toEqual(expect.arrayContaining(['dozen:2', 'red']));

    const snap = await snapshot(h, sessionId);
    expect(snap.session.balance).toBe(106_940);
    expect(snap.session.balance).toBe(START + SCRIPT.reduce((s, r) => s + r.net, 0));
    expect(h.outcomes.calls).toBe(5);
  });

  it('GET /rounds lists the settled rounds newest first', async () => {
    const { rounds } = expectOk(
      await h.api<{ rounds: RoundRecord[] }>('GET', `/api/sessions/${sessionId}/rounds?limit=50`),
      'rounds',
    );
    expect(rounds.map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(rounds.map((r) => r.net)).toEqual([240, -1500, 250, 3400, 4550]);
  });

  it('JSON export: rounds, ledger and session balance are mutually consistent', async () => {
    const res = await h.api('GET', `/api/sessions/${sessionId}/export?format=json`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/application\/json/);
    expect(String(res.headers['content-disposition'] ?? '')).toMatch(/attachment/);
    const exp = JSON.parse(res.text) as SessionExport;

    expect(exp.session.id).toBe(sessionId);
    expect(exp.session.balance).toBe(106_940);
    expect(typeof exp.notice).toBe('string');
    const rounds = [...exp.rounds].sort((a, b) => a.seq - b.seq);
    expect(rounds.map((r) => r.net)).toEqual(SCRIPT.map((s) => s.net));
    expect(rounds.every((r) => r.status === 'settled')).toBe(true);

    // Ledger: one session_start, one stake per round, at most one payout per round; running balance exact.
    const ledger = [...exp.ledger].sort((a, b) => a.id - b.id);
    expect(ledger.filter((e) => e.kind === 'session_start')).toHaveLength(1);
    expect(ledger[0]!.kind).toBe('session_start');
    expect(ledger[0]!.amount).toBe(START);
    let running = 0;
    for (const e of ledger) {
      running += e.amount;
      expect(e.balanceAfter, `ledger #${e.id}`).toBe(running);
    }
    expect(ledgerSum(ledger)).toBe(exp.session.balance);
    for (const r of rounds) {
      const stakes = ledger.filter((e) => e.roundId === r.id && e.kind === 'stake');
      const payouts = ledger.filter((e) => e.roundId === r.id && e.kind === 'payout');
      expect(stakes.map((e) => e.amount)).toEqual([-r.totalStake]);
      expect(payouts.length).toBeLessThanOrEqual(1);
      expect(payouts.reduce((s, e) => s + e.amount, 0)).toBe(r.totalReturned);
      if ((r.totalReturned ?? 0) > 0) expect(payouts).toHaveLength(1);
    }
    // No provider data in a manual session.
    expect(exp.decisions).toEqual([]);
    expect(exp.usage).toEqual([]);
  });

  it('CSV export has the round columns and values that match the settled rounds', async () => {
    const res = await h.api('GET', `/api/sessions/${sessionId}/export?format=csv`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/csv/);
    expect(String(res.headers['content-disposition'] ?? '')).toMatch(/attachment/);
    expect(res.text.endsWith('\r\n')).toBe(true); // RFC 4180 CRLF rows
    const rows = parseCsv(res.text);
    // Exactly one header row + one row per round (the export is per round, oldest first).
    expect(rows).toHaveLength(1 + SCRIPT.length);
    // The documented column set (src/server/db/export.ts CSV_COLUMNS, owned by the persistence agent).
    expect(rows[0]).toEqual([
      'round', 'status', 'committed_at', 'settled_at', 'source', 'decision_action', 'decision_explanation', 'bets',
      'total_stake', 'winning_number', 'color', 'stake_returned', 'winnings', 'total_returned', 'net',
      'balance_before', 'balance_after',
    ]);
    const header = rows[0]!.map(normHeader);
    const at = (row: string[], name: string) => row[header.indexOf(normHeader(name))]!;
    let before = START;
    for (const [i, exp] of SCRIPT.entries()) {
      const line = rows[1 + i]!;
      expect(line).toHaveLength(rows[0]!.length);
      expect(at(line, 'round')).toBe(String(i + 1));
      expect(at(line, 'status')).toBe('settled');
      expect(at(line, 'source')).toBe('manual');
      expect(at(line, 'winning_number')).toBe(String(exp.outcome));
      expect(at(line, 'color')).toBe(colorOf(exp.outcome));
      // Money columns are exact decimal credits ("45.50", "-15.00") — checked without floating point.
      for (const [name, value] of [
        ['total_stake', exp.totalStake],
        ['stake_returned', exp.stakeReturned],
        ['winnings', exp.winnings],
        ['total_returned', exp.totalReturned],
        ['net', exp.net],
        ['balance_before', before],
        ['balance_after', exp.balanceAfter],
      ] as const) {
        expect(at(line, name), `${name} r${i + 1}`).toMatch(/^-?\d+\.\d{2}$/);
        expect(moneyCellEquals(at(line, name), value), `${name} r${i + 1}: ${at(line, name)}`).toBe(true);
      }
      expect(at(line, 'bets').length).toBeGreaterThan(0);
      before = exp.balanceAfter;
    }
    expect(at(rows[4]!, 'net')).toBe('-15.00');
    expect(at(rows[1]!, 'winnings')).toBe('45.50');
  });

  describe('rejected bets → 422 ApiErrorBody, balance and history unchanged', () => {
    // limited: run against a session that CONFIGURES the optional table limits (the default has none).
    const cases: { name: string; bets: unknown; code: string[]; limited?: boolean }[] = [
      { name: 'illegal split 1/5 (diagonal, not adjacent)', bets: [bet('split', 100, { numbers: [1, 5] })], code: ['invalid_bet'] },
      { name: 'illegal split 0/4', bets: [bet('split', 100, { numbers: [0, 4] })], code: ['invalid_bet'] },
      { name: 'corner that is not a square', bets: [bet('corner', 100, { numbers: [1, 2, 3, 4] })], code: ['invalid_bet'] },
      { name: 'fractional subunit stake 10.5', bets: [bet('red', 10.5)], code: ['invalid_bet'] },
      { name: 'stake not a multiple of the 0.10 increment (0.15)', bets: [bet('red', 15)], code: ['invalid_bet'] },
      { name: 'stake over a configured max per bet', bets: [bet('red', 10_010)], code: ['limit_exceeded'], limited: true },
      {
        name: 'combined stake over a configured max per round (3 × 100.00 > 200.00)',
        bets: [bet('red', 10_000), bet('black', 10_000), bet('odd', 10_000)],
        code: ['limit_exceeded'],
        limited: true,
      },
      {
        name: 'more bets than a configured maxBetsPerRound (11 > 10)',
        bets: Array.from({ length: 11 }, (_, n) => bet('straight', 10, { numbers: [n + 1] })),
        code: ['limit_exceeded'],
        limited: true,
      },
      { name: 'dozen index 4', bets: [bet('dozen', 100, { index: 4 })], code: ['invalid_bet'] },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const target = c.limited
          ? (
              await createSession(h, {
                name: 'e2e limited',
                player: { kind: 'manual' },
                limits: { maxStakePerBet: 10_000, maxStakePerRound: 20_000, maxBetsPerRound: 10 },
              })
            ).session.id
          : sessionId;
        const before = await snapshot(h, target);
        const drawsBefore = h.outcomes.calls;
        const res = await h.api('POST', `/api/sessions/${target}/rounds`, { body: { bets: c.bets } });
        expect(res.status, res.text).toBe(422);
        const err = errorBody(res);
        expect(c.code).toContain(err.code);
        expect(err.message.length).toBeGreaterThan(0);
        const after = await snapshot(h, target);
        expect(after.session.balance).toBe(before.session.balance);
        expect(after.session.roundsPlayed).toBe(before.session.roundsPlayed);
        expect(after.currentRound?.id).toBe(before.currentRound?.id);
        expect(h.outcomes.calls).toBe(drawsBefore); // no outcome drawn for a rejected slip
      });
    }

    it('default session has no table limits: 3 × 100.00 and 11 bets in one round are accepted (balance only)', async () => {
      // Own harness + fixture outcomes so the shared session's draw accounting is untouched.
      const own = await createHarness({ label: 'manual-nolimits', outcomes: [7, 8] });
      try {
        const open = await createSession(own, { name: 'e2e no limits', player: { kind: 'manual' } });
        expect(open.session.limits).toMatchObject({ maxStakePerBet: null, maxStakePerRound: null, maxBetsPerRound: null, maxRounds: null, budgetMicros: null });
        const big = await own.api('POST', `/api/sessions/${open.session.id}/rounds`, {
          body: { bets: [bet('red', 10_000), bet('black', 10_000), bet('odd', 10_000)] },
        });
        expect(big.status, big.text).toBe(200);
        const many = await own.api('POST', `/api/sessions/${open.session.id}/rounds`, {
          body: { bets: Array.from({ length: 11 }, (_, n) => bet('straight', 10, { numbers: [n + 1] })) },
        });
        expect(many.status, many.text).toBe(200);
      } finally {
        await own.close({ removeDb: true });
      }
    });

    it('stake over the balance → 422 insufficient_funds (low-balance session)', async () => {
      const poor = await createSession(h, {
        name: 'e2e poor',
        player: { kind: 'manual' },
        limits: { startingBalance: 500 },
      });
      const id = poor.session.id;
      const res = await h.api('POST', `/api/sessions/${id}/rounds`, { body: { bets: [bet('red', 600)] } });
      expect(res.status, res.text).toBe(422);
      expect(errorBody(res).code).toBe('insufficient_funds');
      const after = await snapshot(h, id);
      expect(after.session.balance).toBe(500);
      expect(after.session.roundsPlayed).toBe(0);
      expect(after.currentRound).toBeNull();
    });
  });

  it('replaying POST /rounds with the same Idempotency-Key returns the same round and charges once', async () => {
    const before = await snapshot(h, sessionId);
    const key = crypto.randomUUID();
    const body = { bets: [bet('red', 100)] };
    const first = expectOk(
      await h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body, idempotencyKey: key }),
      'first',
    );
    const second = expectOk(
      await h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body, idempotencyKey: key }),
      'replay',
    );
    expect(second.round.id).toBe(first.round.id);
    expect(second.round.seq).toBe(first.round.seq);
    expect(second.round.winningNumber).toBe(first.round.winningNumber);
    // 2 is black → red @1.00 loses; charged exactly once.
    expect(first.round.net).toBe(-100);
    const after = await snapshot(h, sessionId);
    expect(after.session.balance).toBe(before.session.balance - 100);
    expect(after.session.roundsPlayed).toBe(before.session.roundsPlayed + 1);
  });

  it('two concurrent submissions with the SAME key settle one round', async () => {
    const before = await snapshot(h, sessionId);
    const key = crypto.randomUUID();
    const body = { bets: [bet('red', 100)] };
    const [a, b] = await Promise.all([
      h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body, idempotencyKey: key }),
      h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body, idempotencyKey: key }),
    ]);
    const ok = [a, b].filter((r) => r.status >= 200 && r.status < 300);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) if (r.status >= 300) expect(['duplicate_request', 'round_in_progress']).toContain(errorBody(r).code);
    expect(new Set(ok.map((r) => r.json.round.id)).size).toBe(1);
    const after = await snapshot(h, sessionId);
    expect(after.session.roundsPlayed).toBe(before.session.roundsPlayed + 1);
    expect(after.session.balance).toBe(before.session.balance - 100); // 4 is black
  });

  it('two concurrent submissions with DIFFERENT keys never double-settle; ledger sum == balance', async () => {
    const before = await snapshot(h, sessionId);
    const [a, b] = await Promise.all([
      h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body: { bets: [bet('red', 100)] } }),
      h.api<ManualRoundResponse>('POST', `/api/sessions/${sessionId}/rounds`, { body: { bets: [bet('black', 200)] } }),
    ]);
    const ok = [a, b].filter((r) => r.status >= 200 && r.status < 300);
    // Either both are applied as two sequential rounds, or one is refused as round_in_progress (409).
    for (const r of [a, b]) if (r.status >= 300) expect(errorBody(r).code).toBe('round_in_progress');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const rounds = ok.map((r) => r.json.round).sort((x, y) => x.seq - y.seq);
    expect(new Set(rounds.map((r) => r.seq)).size).toBe(rounds.length);
    let bal = before.session.balance;
    for (const r of rounds) {
      expect(r.status).toBe('settled');
      expect(r.balanceBefore).toBe(bal);
      expect(r.balanceAfter).toBe(bal + r.net!);
      bal = r.balanceAfter!;
    }
    const after = await snapshot(h, sessionId);
    expect(after.session.balance).toBe(bal);
    expect(after.session.roundsPlayed).toBe(before.session.roundsPlayed + rounds.length);

    const exp = JSON.parse((await h.api('GET', `/api/sessions/${sessionId}/export?format=json`)).text) as SessionExport;
    expect(ledgerSum(exp.ledger)).toBe(after.session.balance);
    const payoutsPerRound = new Map<string, number>();
    for (const e of exp.ledger) if (e.kind === 'payout' && e.roundId) payoutsPerRound.set(e.roundId, (payoutsPerRound.get(e.roundId) ?? 0) + 1);
    for (const n of payoutsPerRound.values()) expect(n).toBe(1);
    expect(exp.rounds.every((r) => r.status === 'settled')).toBe(true);
    // Every drawn outcome belongs to exactly one settled round (no orphan draws, no redraws).
    const allRounds = exp.rounds.length;
    expect(h.outcomes.calls).toBe(allRounds);
  });

  it('manual sessions reject autonomous control actions', async () => {
    const res = await h.api<SessionSnapshot>('POST', `/api/sessions/${sessionId}/control`, { body: { action: 'start' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    errorBody(res);
  });

  it('unknown session → 404 ApiErrorBody', async () => {
    const res = await h.api('GET', `/api/sessions/does-not-exist`);
    expect(res.status).toBe(404);
    expect(errorBody(res).code).toBe('not_found');
  });
});
