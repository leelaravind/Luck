/**
 * Export tests: exact money strings, RFC 4180 quoting, formula-injection neutralisation,
 * JSON round-trip and "no secrets / no config" guarantees. Data is FIXTURE data written
 * through a real in-memory repository.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Repository } from '../types.js';
import { at, decision, newSession, playRound, redBet, splitZeroThree, straightBet, usage } from './__tests__/fixtures.js';
import { clearRegisteredSecrets, registerSecret } from '../redact.js';
import {
  CSV_COLUMNS,
  csvQuote,
  formatMicrosUsd,
  formatSubunitsDecimal,
  neutraliseFormula,
  toCsvExport,
  toJsonExport,
} from './export.js';
import { EXPORT_NOTICE, openRepository } from './sqlite.js';

const open: Repository[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function repo(): Repository {
  const r = openRepository(':memory:', { appVersion: '0.1.0-test', now: () => new Date(at(1000)) });
  open.push(r);
  return r;
}

/** Minimal RFC 4180 parser used to read the CSV back (test helper). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) throw new Error('CSV does not end with CRLF');
  return rows;
}

describe('formatSubunitsDecimal (integer math)', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [-5, '-0.05'],
    [10, '0.10'],
    [100, '1.00'],
    [1234, '12.34'],
    [-1234, '-12.34'],
    [100_000, '1000.00'],
    [-99, '-0.99'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
    [-Number.MAX_SAFE_INTEGER, '-90071992547409.91'],
  ])('%d → %s', (n, s) => {
    expect(formatSubunitsDecimal(n)).toBe(s);
  });

  it('refuses non-integers', () => {
    expect(() => formatSubunitsDecimal(1.5)).toThrow(RangeError);
    expect(() => formatSubunitsDecimal(Number.NaN)).toThrow(RangeError);
  });
});

describe('cell helpers', () => {
  it('neutralises cells a spreadsheet would evaluate', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) expect(neutraliseFormula(s)).toBe(`'${s}`);
    for (const s of ['Red 1.00', 'a=b', '', ' =x']) expect(neutraliseFormula(s)).toBe(s);
  });

  it('quotes per RFC 4180', () => {
    expect(csvQuote('plain')).toBe('plain');
    expect(csvQuote('a,b')).toBe('"a,b"');
    expect(csvQuote('say "hi"')).toBe('"say ""hi"""');
    expect(csvQuote('line1\nline2')).toBe('"line1\nline2"');
    expect(csvQuote('cr\rhere')).toBe('"cr\rhere"');
  });
});

function seededSession(r: Repository) {
  r.createSession(newSession('s1', { mode: 'ai', player: { kind: 'ollama', model: 'fixture-model' } }));
  // Round 1: AI bet with a hostile explanation (formula + quotes + comma + newline).
  r.insertDecision(
    decision('s1', 'd1', {
      status: 'accepted',
      action: 'bet',
      bets: [
        { type: 'red', stake: 100 },
        { type: 'split', numbers: [0, 3], stake: 50 },
      ],
      explanation: '=HYPERLINK("http://evil.example","click"), then\nred',
      startedAt: at(1),
    }),
  );
  r.commitRound({
    id: 'r1',
    sessionId: 's1',
    source: 'ai',
    decisionId: 'd1',
    bets: [redBet(100), splitZeroThree(50)],
    idempotencyKey: 'k1',
    committedAt: at(2),
  });
  r.recordOutcome('r1', 4, at(3)); // 4 is black: both bets lose
  r.settleRound('r1', { winningNumber: 4, totalStake: 150, stakeReturned: 0, winnings: 0, totalReturned: 0, net: -150, bets: [{ key: 'red', won: false, returned: 0 }, { key: 'split:0-3', won: false, returned: 0 }] }, at(4));
  // Round 2: a skip (no-bet round) with a "-" leading explanation.
  r.insertDecision(decision('s1', 'd2', { status: 'accepted', action: 'skip', explanation: '-sitting this one out', startedAt: at(5), roundNumber: 2 }));
  r.commitRound({ id: 'r2', sessionId: 's1', source: 'ai', decisionId: 'd2', bets: [], idempotencyKey: 'k2', committedAt: at(6) });
  r.recordOutcome('r2', 0, at(7));
  r.settleRound('r2', { winningNumber: 0, totalStake: 0, stakeReturned: 0, winnings: 0, totalReturned: 0, net: 0, bets: [] }, at(8));
  // Round 3: manual winner on 0.
  playRound(r, 's1', 'r3', [straightBet(0, 5)], 0, 10);
  // Round 4: committed but not yet settled (shows up with empty result cells).
  r.commitRound({ id: 'r4', sessionId: 's1', source: 'manual', decisionId: null, bets: [redBet(10)], idempotencyKey: 'k4', committedAt: at(20) });
}

describe('toCsvExport', () => {
  it('writes one row per round with exact money, quoting and formula neutralisation', () => {
    const r = repo();
    seededSession(r);
    const csv = toCsvExport(r.exportSession('s1'));
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(1 + 4);
    const byCol = (row: string[]) => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, row[i]]));

    expect(byCol(rows[1]!)).toEqual({
      round: '1',
      status: 'settled',
      committed_at: at(2),
      settled_at: at(4),
      source: 'ai',
      decision_action: 'bet',
      decision_explanation: `'=HYPERLINK("http://evil.example","click"), then\nred`,
      bets: 'Red 1.00; Split 0/3 0.50',
      total_stake: '1.50',
      winning_number: '4',
      color: 'black',
      stake_returned: '0.00',
      winnings: '0.00',
      total_returned: '0.00',
      net: '-1.50', // numeric money cell: NOT apostrophe-prefixed
      balance_before: '1000.00',
      balance_after: '998.50',
      // No usage records in this fixture: token/cost cells are blank, never 0.
      decision_input_tokens: '',
      decision_output_tokens: '',
      decision_cached_tokens: '',
      decision_cost_usd: '',
      decision_cost_basis: '',
    });
    expect(byCol(rows[2]!)).toMatchObject({
      round: '2',
      decision_action: 'skip',
      decision_explanation: "'-sitting this one out",
      bets: '',
      total_stake: '0.00',
      winning_number: '0',
      color: 'green',
      net: '0.00',
      balance_after: '998.50',
    });
    expect(byCol(rows[3]!)).toMatchObject({
      round: '3',
      source: 'manual',
      decision_action: '',
      decision_explanation: '',
      bets: 'Straight 0 0.05',
      total_stake: '0.05',
      stake_returned: '0.05',
      winnings: '1.75',
      total_returned: '1.80',
      net: '1.75',
      balance_after: '1000.25',
    });
    expect(byCol(rows[4]!)).toMatchObject({
      round: '4',
      status: 'committed',
      settled_at: '',
      winning_number: '',
      color: '',
      total_returned: '',
      net: '',
      balance_before: '1000.25',
      balance_after: '',
    });
    // The raw text really is quoted (RFC 4180) rather than relying on the parser above.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click""), then\nred"`);
  });

  it('writes only the header for a session without rounds', () => {
    const r = repo();
    r.createSession(newSession('empty'));
    expect(toCsvExport(r.exportSession('empty'))).toBe(`${CSV_COLUMNS.join(',')}\r\n`);
  });
});

describe('toJsonExport', () => {
  it('round-trips exactly and carries the notice', () => {
    const r = repo();
    seededSession(r);
    r.insertUsage(usage('s1', 'd1', 'u1', { costMicros: 0.5, costBasis: 'estimated-from-pricing' }));
    r.appendLog('s1', 'info', 'round', 'Round 1 settled');
    const exp = r.exportSession('s1');
    const text = toJsonExport(exp);
    expect(JSON.parse(text)).toEqual(exp);
    expect(exp.notice).toBe(EXPORT_NOTICE);
    expect(exp.notice).toBe(
      'Virtual credits only. Roulette outcomes are random and cannot be predicted; results do not demonstrate model skill.',
    );
    expect(exp.app).toEqual({ name: 'Luck — AI Roulette Lab', version: '0.1.0-test' });
    expect(exp.exportedAt).toBe(at(1000));
    expect(exp.rounds.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('exports contain only what was stored — no secrets, config or env', () => {
  it('the repository export holds stored text verbatim; the JSON/CSV files mask key-shaped text and add nothing else', () => {
    const FAKE_KEY = 'sk-ant-api03-FAKE0000000000000000000000000000-fixture';
    const ENV_ONLY = 'env-only-FAKE-secret-value-7f3a';
    const prev = process.env.LUCK_TEST_FAKE_SECRET;
    process.env.LUCK_TEST_FAKE_SECRET = ENV_ONLY;
    try {
      const r = repo();
      r.createSession(
        newSession('s1', {
          mode: 'ai',
          // A caller mistakenly passing a server-side resolved config: the key must not be stored.
          player: { kind: 'anthropic', model: 'user-model', apiKey: ENV_ONLY } as never,
        }),
      );
      // Text that callers chose to store is kept verbatim by the repository (redaction at storage is
      // the caller's job, D4) — but the serialised export files mask it again (audit #33).
      const d = decision('s1', 'd1', {
        status: 'failed',
        rawOutput: `provider said: invalid x-api-key ${FAKE_KEY}`,
        errorMessage: `auth failed for ${FAKE_KEY}`,
      });
      r.insertDecision(d);
      const log = r.appendLog('s1', 'error', 'provider', `request failed with ${FAKE_KEY}`);

      const exp = r.exportSession('s1');
      expect(Object.keys(exp).sort()).toEqual(
        ['app', 'decisions', 'exportedAt', 'ledger', 'logs', 'notice', 'rounds', 'session', 'usage'].sort(),
      );
      expect(Object.keys(exp.app).sort()).toEqual(['name', 'version']);
      expect(exp.decisions).toEqual([d]);
      expect(exp.logs).toEqual([log]);
      expect(exp.session.player).toEqual({ kind: 'anthropic', model: 'user-model' });

      const json = toJsonExport(exp);
      const csv = toCsvExport(exp);
      for (const out of [json, csv]) {
        expect(out).not.toContain(ENV_ONLY);
        expect(out).not.toMatch(/apiKey|cliPath|useSubscriptionAuth|dbPath|dataDir/);
        expect(out).not.toContain(FAKE_KEY);
        expect(out).not.toContain('sk-ant-');
      }
      // The three stored text fields are still exported, with the key masked.
      const parsed = JSON.parse(json) as typeof exp;
      expect(parsed.decisions[0]!.rawOutput).toBe('provider said: invalid x-api-key [redacted]');
      expect(parsed.decisions[0]!.errorMessage).toBe('auth failed for [redacted]');
      expect(parsed.logs[0]!.message).toBe('request failed with [redacted]');
    } finally {
      if (prev === undefined) delete process.env.LUCK_TEST_FAKE_SECRET;
      else process.env.LUCK_TEST_FAKE_SECRET = prev;
    }
  });
});

describe('final redact() pass over exports (audit #33)', () => {
  // A registered secret that matches no key PATTERN: only the exact-value layer can catch it.
  const REGISTERED = 'fixture-registered-value-9c1e77';
  afterEach(() => clearRegisteredSecrets());

  function echoingSession(r: Repository) {
    r.createSession(newSession('s1', { mode: 'ai', player: { kind: 'openai', model: `model-${REGISTERED}` } }));
    // A misbehaving provider echoed the key it received into every free-text field.
    r.insertDecision(
      decision('s1', 'd1', {
        status: 'accepted',
        action: 'bet',
        bets: [{ type: 'red', stake: 100 }],
        explanation: `I was given ${REGISTERED}, betting red`,
        rawOutput: `{"action":"bet","explanation":"key ${REGISTERED}","note":"x-api-key: abc\\n\\"q\\""}`,
        providerNote: `echo ${REGISTERED}`,
        startedAt: at(1),
      }),
    );
    r.insertUsage(usage('s1', 'd1', 'u1', { model: REGISTERED }));
    r.commitRound({ id: 'r1', sessionId: 's1', source: 'ai', decisionId: 'd1', bets: [redBet(100)], idempotencyKey: 'k1', committedAt: at(2) });
    r.recordOutcome('r1', 1, at(3));
    r.settleRound('r1', { winningNumber: 1, totalStake: 100, stakeReturned: 100, winnings: 100, totalReturned: 200, net: 100, bets: [{ key: 'red', won: true, returned: 200 }] }, at(4));
    r.appendLog('s1', 'warn', 'provider', `provider echoed ${REGISTERED}`);
  }

  it('masks a registered secret in explanation, raw output, notes, models and logs (JSON stays valid)', () => {
    registerSecret(REGISTERED);
    const r = repo();
    echoingSession(r);
    const exp = r.exportSession('s1');
    expect(exp.decisions[0]!.explanation).toContain(REGISTERED); // stored verbatim…
    const json = toJsonExport(exp);
    expect(json).not.toContain(REGISTERED); // …exported masked
    const parsed = JSON.parse(json) as typeof exp;
    expect(parsed.decisions[0]!.explanation).toBe('I was given [redacted], betting red');
    expect(parsed.decisions[0]!.providerNote).toBe('echo [redacted]');
    expect(parsed.session.player.model).toBe('model-[redacted]');
    expect(parsed.usage[0]!.model).toBe('[redacted]');
    expect(parsed.logs[0]!.message).toBe('provider echoed [redacted]');
    // Everything else is untouched.
    expect(parsed.rounds).toEqual(exp.rounds);
    expect(parsed.ledger).toEqual(exp.ledger);
  });

  it('masks a registered secret in the CSV and keeps every row and cell in place', () => {
    registerSecret(REGISTERED);
    const r = repo();
    echoingSession(r);
    const csv = toCsvExport(r.exportSession('s1'));
    expect(csv).not.toContain(REGISTERED);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.length === CSV_COLUMNS.length)).toBe(true);
    const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1]![i]]));
    expect(row).toMatchObject({ decision_explanation: 'I was given [redacted], betting red', net: '1.00' });
  });

  it('never breaks the CSV structure when a key pattern sits next to a cell boundary', () => {
    const r = repo();
    r.createSession(newSession('s1', { mode: 'ai', player: { kind: 'ollama', model: 'm' } }));
    // "?key=…" is masked up to &, whitespace or a quote — not at a comma.
    r.insertDecision(decision('s1', 'd1', { status: 'accepted', action: 'skip', explanation: 'see http://x/?key=abc123', startedAt: at(1) }));
    r.commitRound({ id: 'r1', sessionId: 's1', source: 'ai', decisionId: 'd1', bets: [], idempotencyKey: 'k1', committedAt: at(2) });
    const csv = toCsvExport(r.exportSession('s1'));
    const rows = parseCsv(csv);
    expect(rows[1]).toHaveLength(CSV_COLUMNS.length);
    const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1]![i]]));
    expect(row).toMatchObject({ decision_explanation: 'see http://x/?key=[redacted]', bets: '', total_stake: '0.00' });
    expect(csv).not.toContain('abc123');
  });

  it('keeps the JSON valid when a key pattern ends right before an escaped quote', () => {
    const r = repo();
    r.createSession(newSession('s1'));
    r.insertDecision(decision('s1', 'd1', { status: 'failed', rawOutput: 'password=hunter2"and more\npassword=x\\"y' }));
    const json = toJsonExport(r.exportSession('s1'));
    const parsed = JSON.parse(json) as { decisions: { rawOutput: string }[] };
    expect(parsed.decisions[0]!.rawOutput).not.toContain('hunter2');
    expect(parsed.decisions[0]!.rawOutput).toContain('[redacted]');
  });
});

describe('per-decision token and cost columns (audit #5)', () => {
  it('sums every attempt of the round’s decision; blank when nothing was reported', () => {
    expect(CSV_COLUMNS).toEqual(
      expect.arrayContaining(['decision_input_tokens', 'decision_output_tokens', 'decision_cached_tokens', 'decision_cost_usd', 'decision_cost_basis']),
    );
    const r = repo();
    r.createSession(newSession('s1', { mode: 'ai', player: { kind: 'anthropic', model: 'fixture-model' } }));
    // Round 1: two attempts (a timeout without usage, then a success with cache reads and a cost).
    r.insertDecision(decision('s1', 'd1', { status: 'accepted', action: 'bet', startedAt: at(1) }));
    r.insertUsage(usage('s1', 'd1', 'u1', { attempt: 1, status: 'timeout', known: false, inputTokens: null, outputTokens: null, costMicros: null, costBasis: 'unknown', createdAt: at(1) }));
    r.insertUsage(usage('s1', 'd1', 'u2', { attempt: 2, inputTokens: 1_200, outputTokens: 80, cacheReadTokens: 1_000, costMicros: 1_234.5, costBasis: 'estimated-from-pricing', createdAt: at(2) }));
    playAiRound(r, 'r1', 'd1', 10);
    // Round 2: one attempt, provider reported nothing at all.
    r.insertDecision(decision('s1', 'd2', { status: 'accepted', action: 'skip', startedAt: at(20), roundNumber: 2 }));
    r.insertUsage(usage('s1', 'd2', 'u3', { known: false, inputTokens: null, outputTokens: null, costMicros: null, costBasis: 'unknown', createdAt: at(20) }));
    playAiRound(r, 'r2', 'd2', 30, []);
    // Round 3: two successful attempts, both with tokens; a local provider (no charge).
    r.insertDecision(decision('s1', 'd3', { status: 'accepted', action: 'skip', startedAt: at(40), roundNumber: 3 }));
    r.insertUsage(usage('s1', 'd3', 'u4', { attempt: 1, inputTokens: 500, outputTokens: 20, costMicros: 0, costBasis: 'local-no-charge', createdAt: at(40) }));
    r.insertUsage(usage('s1', 'd3', 'u5', { attempt: 2, inputTokens: 510, outputTokens: 25, costMicros: 0, costBasis: 'local-no-charge', createdAt: at(41) }));
    playAiRound(r, 'r3', 'd3', 50, []);
    // Round 4: manual round, no decision.
    playRound(r, 's1', 'r4', [redBet(10)], 2, 60);

    const rows = parseCsv(toCsvExport(r.exportSession('s1')));
    const cols = (i: number) => {
      const row = Object.fromEntries(CSV_COLUMNS.map((c, j) => [c, rows[i]![j]]));
      return [row.decision_input_tokens, row.decision_output_tokens, row.decision_cached_tokens, row.decision_cost_usd, row.decision_cost_basis];
    };
    expect(cols(1)).toEqual(['1200', '80', '1000', '0.0012345', 'estimated-from-pricing']);
    expect(cols(2)).toEqual(['', '', '', '', '']);
    expect(cols(3)).toEqual(['1010', '45', '', '0', 'local-no-charge']);
    expect(cols(4)).toEqual(['', '', '', '', '']);
  });

  it('formats micro-USD as a plain decimal', () => {
    expect(formatMicrosUsd(0)).toBe('0');
    expect(formatMicrosUsd(1_234.5)).toBe('0.0012345');
    expect(formatMicrosUsd(2_500_000)).toBe('2.5');
    expect(formatMicrosUsd(0.5)).toBe('0.0000005');
    expect(formatMicrosUsd(12_345_678)).toBe('12.345678');
    expect(() => formatMicrosUsd(Number.NaN)).toThrow(RangeError);
  });
});

/** Commit → outcome 1 (red) → settle an AI round linked to `decisionId`. */
function playAiRound(r: Repository, id: string, decisionId: string, sec: number, bets = [redBet(100)]) {
  r.commitRound({ id, sessionId: 's1', source: 'ai', decisionId, bets, idempotencyKey: `k-${id}`, committedAt: at(sec) });
  r.recordOutcome(id, 1, at(sec + 1));
  const won = bets.length > 0;
  r.settleRound(
    id,
    {
      winningNumber: 1,
      totalStake: won ? 100 : 0,
      stakeReturned: won ? 100 : 0,
      winnings: won ? 100 : 0,
      totalReturned: won ? 200 : 0,
      net: won ? 100 : 0,
      bets: won ? [{ key: 'red', won: true, returned: 200 }] : [],
    },
    at(sec + 2),
  );
}
