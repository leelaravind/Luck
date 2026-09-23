/**
 * Unit tests for the pure session helpers (demo player, observation, prompts, retry, budget,
 * usage, settings, provider registry). All inputs are TEST FIXTURES; no provider is contacted.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  GameError,
  type RoundRecord,
  type SessionInfo,
  type UsageRecord,
} from '../../shared/contracts.js';
import { openRepository } from '../db/sqlite.js';
import { resolveProviderConfig, sameEndpoint } from '../providers/registry.js';
import { DEFAULT_PRICING } from '../providers/pricing.js';
import { checkBudget, CLI_MIN_WORST_CASE_MICROS, conservativeSpentMicros, estimateInputTokens } from './budget.js';
import { createDemoPlayer, DEMO_PLAYER_LABEL, demoBetType, demoStake } from './demoPlayer.js';
import { buildObservation } from './observation.js';
import { buildCorrectiveNote, buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { computeBackoffMs, MAX_RETRY_AFTER_MS } from './retry.js';
import { loadSettings, saveSettings, validateCreateSessionRequest, validateLimits } from './settings.js';
import { attemptCost, buildUsageRecord, outputTokensPerSec, summarizeUsage } from './usage.js';
import { FAKE_ANTHROPIC_KEY, testConfig } from './__tests__/helpers.js';

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-internal-id-1',
    name: 'fixture',
    mode: 'ai',
    player: { kind: 'ollama', model: 'fixture-model' },
    status: 'running',
    phase: 'requesting_decision',
    pauseReason: null,
    endReason: null,
    message: null,
    balance: 99_000,
    startingBalance: 100_000,
    roundsPlayed: 2,
    limits: { ...DEFAULT_LIMITS },
    epoch: 0,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    runtimeMs: 0,
    ...over,
  };
}

function round(seq: number, over: Partial<RoundRecord> = {}): RoundRecord {
  return {
    id: `round-internal-${seq}`,
    sessionId: 'sess-internal-id-1',
    seq,
    status: 'settled',
    source: 'ai',
    decisionId: `decision-internal-${seq}`,
    bets: [
      { key: 'red', type: 'red', numbers: [1, 3], stake: 100, payout: 1, label: 'Red', won: false, returned: 0 },
      { key: 'straight:17', type: 'straight', numbers: [17], stake: 10, payout: 35, label: 'Straight 17', won: true, returned: 360 },
      { key: 'dozen:2', type: 'dozen', numbers: [13, 14], index: 2, stake: 10, payout: 2, label: '2nd Dozen', won: true, returned: 30 },
    ],
    totalStake: 120,
    balanceBefore: 100_000,
    winningNumber: 17,
    stakeReturned: 20,
    winnings: 370,
    totalReturned: 390,
    net: 270,
    balanceAfter: 100_270,
    committedAt: '2026-09-23T00:00:00.000Z',
    outcomeAt: '2026-09-23T00:00:00.000Z',
    settledAt: '2026-09-23T00:00:00.000Z',
    ...over,
  };
}

// ───────────────────────────── demo player ─────────────────────────────

describe('demo player (rule-based, not AI)', () => {
  const obs = (roundNumber: number, balance: number, limits = DEFAULT_LIMITS) =>
    buildObservation(session({ roundsPlayed: roundNumber - 1, balance, limits }), []);

  it('bets a flat 1 credit on even-money bets cycling red, black, odd, even, low, high', () => {
    const p = createDemoPlayer();
    const types = [1, 2, 3, 4, 5, 6, 7].map((n) => {
      const d = p.decide(obs(n, 10_000));
      expect(d.action).toBe('bet');
      expect(d.bets).toHaveLength(1);
      expect(d.bets![0]!.stake).toBe(100);
      return d.bets![0]!.type;
    });
    expect(types).toEqual(['red', 'black', 'odd', 'even', 'low', 'high', 'red']);
  });

  it('labels itself and states it has no predictive ability', () => {
    const d = createDemoPlayer().decide(obs(1, 10_000));
    expect(d.explanation).toContain(DEMO_PLAYER_LABEL);
    expect(d.explanation).toMatch(/no predictive ability/);
    expect(d.explanation.length).toBeLessThanOrEqual(280);
  });

  it('skips when the balance cannot cover the stake', () => {
    const d = createDemoPlayer().decide(obs(3, 99));
    expect(d.action).toBe('skip');
    expect(d.bets).toBeUndefined();
    expect(d.explanation).toMatch(/skipped/);
  });

  it('uses max(minStake, 100 rounded to the increment), clamped to the per-bet cap', () => {
    const l = (o: Partial<typeof DEFAULT_LIMITS>) => ({ ...buildObservation(session({ limits: { ...DEFAULT_LIMITS, ...o } }), []).limits });
    expect(demoStake(l({ minStake: 10, stakeIncrement: 10 }))).toBe(100);
    expect(demoStake(l({ minStake: 250, stakeIncrement: 50 }))).toBe(250);
    expect(demoStake(l({ minStake: 30, stakeIncrement: 30 }))).toBe(90); // 100 → nearest multiple of 30
    expect(demoStake(l({ minStake: 10, stakeIncrement: 10, maxStakePerBet: 50 }))).toBe(50);
    expect(demoBetType(13)).toBe('red');
  });
});

// ───────────────────────────── observation ─────────────────────────────

const OBS_KEYS = ['schemaVersion', 'game', 'roundNumber', 'balance', 'units', 'limits', 'betTypes', 'rules', 'history', 'stats'].sort();
const LIMIT_KEYS = ['minStake', 'stakeIncrement', 'maxStakePerBet', 'maxStakePerRound', 'maxBetsPerRound', 'roundsRemaining'].sort();
const ROUND_KEYS = ['round', 'winningNumber', 'color', 'yourBets', 'yourTotalStake', 'yourNet'].sort();

describe('buildObservation', () => {
  it('contains only whitelisted keys and no internal ids', () => {
    const obs = buildObservation(session(), [round(2), round(1)]);
    expect(Object.keys(obs).sort()).toEqual(OBS_KEYS);
    expect(Object.keys(obs.limits).sort()).toEqual(LIMIT_KEYS);
    expect(Object.keys(obs.stats).sort()).toEqual(['netResult', 'roundsPlayed']);
    for (const h of obs.history) {
      expect(Object.keys(h).sort()).toEqual(ROUND_KEYS);
      for (const b of h.yourBets) {
        for (const k of Object.keys(b)) expect(['type', 'numbers', 'index', 'stake']).toContain(k);
      }
    }
    const json = JSON.stringify(obs);
    expect(json).not.toContain('internal');
    expect(json).not.toContain('decisionId');
    expect(json).not.toContain('balanceAfter');
    expect(obs.history.map((h) => h.round)).toEqual([1, 2]); // chronological
    expect(obs.roundNumber).toBe(3);
    expect(obs.stats.netResult).toBe(-1_000);
    // outside bets carry no numbers; inside bets keep them; dozen keeps its index
    expect(obs.history[0]!.yourBets).toEqual([
      { type: 'red', stake: 100 },
      { type: 'straight', numbers: [17], stake: 10 },
      { type: 'dozen', index: 2, stake: 10 },
    ]);
  });

  it('excludes pending (committed / outcome_recorded) rounds and other sessions', () => {
    const pending = round(3, { status: 'committed', winningNumber: null, net: null, outcomeAt: null, settledAt: null });
    const recorded = round(4, { status: 'outcome_recorded', winningNumber: 5, net: null, settledAt: null });
    const foreign = round(1, { sessionId: 'other' });
    const obs = buildObservation(session(), [pending, recorded, round(2), foreign]);
    expect(obs.history.map((h) => h.round)).toEqual([2]);
    expect(JSON.stringify(obs)).not.toContain('"winningNumber":5');
  });

  it('keeps only the last historyWindow settled rounds', () => {
    const rounds = [1, 2, 3, 4, 5].map((n) => round(n));
    const obs = buildObservation(session({ limits: { ...DEFAULT_LIMITS, historyWindow: 2 } }), rounds);
    expect(obs.history.map((h) => h.round)).toEqual([4, 5]);
    const none = buildObservation(session({ limits: { ...DEFAULT_LIMITS, historyWindow: 0 } }), rounds);
    expect(none.history).toEqual([]);
  });

  it('reports roundsRemaining from maxRounds', () => {
    expect(buildObservation(session({ roundsPlayed: 2, limits: { ...DEFAULT_LIMITS, maxRounds: 50 } }), []).limits.roundsRemaining).toBe(48);
    // Default: no round limit (sessions run until the balance is exhausted or the user stops).
    expect(DEFAULT_LIMITS.maxRounds).toBeNull();
    expect(buildObservation(session({ limits: { ...DEFAULT_LIMITS, maxRounds: null } }), []).limits.roundsRemaining).toBeNull();
  });
});

// ───────────────────────────── prompts ─────────────────────────────

describe('prompts', () => {
  const obs = buildObservation(session(), [round(1)]);

  it('system prompt states rules, payouts, limits and the JSON-only format', () => {
    const sys = buildSystemPrompt(obs);
    expect(sys).toMatch(/JSON object and nothing else/);
    expect(sys).toMatch(/at most 400 characters/);
    expect(sys).toMatch(/Do not include hidden reasoning/);
    expect(sys).toMatch(/Outcomes are independent and cannot be predicted/);
    // Asks for a named strategy, gives no concrete bet as an example (no anchoring on red), and by
    // default does not offer "stop".
    expect(sys).toMatch(/"strategy" names the betting strategy/);
    expect(sys).toMatch(/Every bet type in PAYOUTS is equally allowed/);
    expect(sys).not.toContain('"type":"red"');
    expect(sys).not.toContain('{"action":"stop"');
    expect(sys).toMatch(/You cannot end the session/);
    const withStop = buildSystemPrompt(obs, { allowStop: true });
    expect(withStop).toContain('{"action":"stop"');
    expect(withStop).not.toMatch(/You cannot end the session/);
    expect(sys).toContain('straight 35:1');
    // Default: no table limits — only the balance caps the combined stake.
    expect(sys).toMatch(/combined stake of all bets in a round can be anything up to your current balance/);
    expect(sys).toMatch(/no limit on the number of bets per round/);
    expect(sys).toMatch(/OBJECTIVE/);
    expect(sys).toMatch(/Try to grow your balance/);
    const limited = buildSystemPrompt(buildObservation(session({ limits: { ...DEFAULT_LIMITS, maxStakePerRound: 20_000, maxBetsPerRound: 10 } }), []));
    expect(limited).toContain('<= 20000');
    expect(limited).toContain('at most 10 bets per round');
    expect(sys).toContain(`multiple of ${DEFAULT_LIMITS.stakeIncrement}`);
  });

  it('user prompt carries exactly the observation JSON (plus optional corrective note)', () => {
    const user = buildUserPrompt(obs);
    const json = user.split('\n')[1]!;
    expect(JSON.parse(json)).toEqual(obs);
    const note = buildCorrectiveNote(['Bet 1: bad', 'x'.repeat(500), 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(note).toContain('Bet 1: bad');
    expect(note).toContain('(2 more)');
    expect(note.length).toBeLessThan(2_000);
    expect(buildUserPrompt(obs, note)).toContain('previous reply was rejected');
  });
});

// ───────────────────────────── retry ─────────────────────────────

describe('computeBackoffMs', () => {
  it('honours retryAfterMs exactly, capped at 30 s', () => {
    expect(computeBackoffMs(1, { retryAfterMs: 1_234 })).toBe(1_234);
    expect(computeBackoffMs(1, { retryAfterMs: 120_000 })).toBe(MAX_RETRY_AFTER_MS);
  });

  it('uses 1 s, 2 s, 4 s with up to 25 % jitter otherwise', () => {
    expect(computeBackoffMs(1, null, () => 0)).toBe(1_000);
    expect(computeBackoffMs(2, null, () => 0)).toBe(2_000);
    expect(computeBackoffMs(3, null, () => 0)).toBe(4_000);
    expect(computeBackoffMs(9, null, () => 0)).toBe(4_000);
    expect(computeBackoffMs(1, null, () => 0.999)).toBe(1_249);
  });
});

// ───────────────────────────── budget ─────────────────────────────

function usage(over: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'u',
    sessionId: 's',
    decisionId: 'd',
    attempt: 1,
    providerKind: 'anthropic',
    model: 'm',
    status: 'ok',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    known: true,
    latencyMs: 1,
    generationMs: null,
    outputTokensPerSec: null,
    costMicros: 0,
    costBasis: 'estimated-from-pricing',
    rateLimit: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    ...over,
  };
}

describe('budget pre-check', () => {
  const pricing = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' as const };
  const caps = { kind: 'anthropic' as const, reportsCost: false };

  it('blocks when spent + worst case would exceed the budget', () => {
    // worst = ceil(3000/3)=1000 tokens × $3 + 400 × $15 = 3000 + 6000 = 9000 µ$
    const base = { capabilities: caps, pricing, promptChars: 3_000, maxOutputTokens: 400 };
    expect(checkBudget({ ...base, budgetMicros: 9_000, records: [] })).toMatchObject({ allowed: true, worstCaseMicros: 9_000 });
    const blocked = checkBudget({ ...base, budgetMicros: 9_000, records: [usage({ costMicros: 1 })] });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.message).toMatch(/Budget exhausted/);
  });

  it('counts unknown-cost attempts that may have been billed (and outstanding ones) as worst case', () => {
    const recs = [
      usage({ costMicros: null, costBasis: 'unknown', status: 'timeout', known: false }),
      // A post-send error (e.g. ECONNRESET / 5xx) may still have been processed: counted (reviewer D1).
      usage({ costMicros: null, costBasis: 'unknown', status: 'error', known: false }),
      usage({ costMicros: null, costBasis: 'unknown', status: 'rate_limited', known: false }), // 429: rejected, not billed
      usage({ costMicros: 500 }),
    ];
    expect(conservativeSpentMicros(recs, 9_000)).toBe(18_500);
    expect(conservativeSpentMicros(recs, 9_000, 2)).toBe(36_500);
  });

  it('Claude Code CLI without pricing: max(2 × last reported cost, 50 000 µ$)', () => {
    const cli = { kind: 'claude-cli' as const, reportsCost: true };
    const base = { capabilities: cli, pricing: null, promptChars: 1_000, maxOutputTokens: 400, budgetMicros: 1_000_000 };
    expect(checkBudget({ ...base, records: [] })).toMatchObject({ allowed: true, worstCaseMicros: CLI_MIN_WORST_CASE_MICROS });
    const recs = [usage({ providerKind: 'claude-cli', costMicros: 40_000, costBasis: 'provider-reported' })];
    expect(checkBudget({ ...base, records: recs })).toMatchObject({ allowed: true, worstCaseMicros: 80_000 });
  });

  it('no app spending limit allows the call; a set limit with an unboundable cost refuses', () => {
    const unlimited = checkBudget({ capabilities: caps, pricing, promptChars: 10, maxOutputTokens: 1, budgetMicros: null, records: [] });
    expect(unlimited.allowed).toBe(true);
    expect(unlimited.remainingMicros).toBeNull();
    expect(checkBudget({ capabilities: caps, pricing: null, promptChars: 10, maxOutputTokens: 1, budgetMicros: 1e6, records: [] }).allowed).toBe(false);
    expect(estimateInputTokens(10)).toBe(4);
  });
});

// ───────────────────────────── usage ─────────────────────────────

describe('usage accounting', () => {
  it('computes throughput from generation time, else latency; null when unknown', () => {
    expect(outputTokensPerSec(100, 2_000, 5_000)).toBe(50);
    expect(outputTokensPerSec(100, null, 4_000)).toBe(25);
    expect(outputTokensPerSec(null, 1_000, 1_000)).toBeNull();
    expect(outputTokensPerSec(100, null, null)).toBeNull();
  });

  it('cost basis: local no charge, provider-reported, estimated, unknown', () => {
    const known = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, known: true };
    const pricing = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' as const };
    expect(attemptCost({ capabilities: { paid: false, reportsCost: false }, usage: known, providerCostUsd: null, pricing })).toEqual({ costMicros: 0, costBasis: 'local-no-charge' });
    expect(attemptCost({ capabilities: { paid: true, reportsCost: true }, usage: known, providerCostUsd: 0.0123, pricing: null })).toEqual({ costMicros: 12_300, costBasis: 'provider-reported' });
    expect(attemptCost({ capabilities: { paid: true, reportsCost: false }, usage: known, providerCostUsd: null, pricing })).toEqual({ costMicros: 4_500, costBasis: 'estimated-from-pricing' });
    expect(attemptCost({ capabilities: { paid: true, reportsCost: false }, usage: { ...known, known: false }, providerCostUsd: null, pricing })).toEqual({ costMicros: null, costBasis: 'unknown' });
  });

  it('builds a record per attempt and summarises failed / unknown / partial cost', () => {
    const rec = buildUsageRecord({
      sessionId: 's',
      decisionId: 'd',
      attempt: 2,
      providerKind: 'ollama',
      model: 'm',
      status: 'ok',
      result: {
        ok: true,
        text: '{}',
        usage: { inputTokens: 10, outputTokens: 40, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, known: true },
        latencyMs: 3_000,
        generationMs: 1_000,
        providerCostUsd: null,
        modelReported: 'm:latest',
        finishReason: 'stop',
        rateLimit: null,
        error: null,
      },
      capabilities: { paid: false, reportsCost: false },
      pricing: null,
      createdAt: 'now',
    });
    expect(rec).toMatchObject({ attempt: 2, model: 'm:latest', outputTokensPerSec: 40, costMicros: 0, costBasis: 'local-no-charge', known: true });

    const s = summarizeUsage(
      [
        usage({ costMicros: 1_000, latencyMs: 100, outputTokens: 10, inputTokens: 5 }),
        usage({ status: 'timeout', known: false, costMicros: null, costBasis: 'unknown', latencyMs: null, inputTokens: null, outputTokens: null }),
        usage({ costMicros: 2_000, latencyMs: 300, outputTokensPerSec: 12.5 }),
      ],
      { budgetMicros: 10_000, paid: true, defaultBasis: 'unknown' },
    );
    expect(s).toMatchObject({
      requests: 3,
      failedRequests: 1,
      unknownUsageRequests: 1,
      costMicros: 3_000,
      costIsPartial: true,
      costBasis: 'estimated-from-pricing',
      lastLatencyMs: 300,
      avgLatencyMs: 200,
      lastOutputTokensPerSec: 12.5,
      budgetMicros: 10_000,
      budgetRemainingMicros: 7_000,
    });
    expect(summarizeUsage([], { budgetMicros: 10_000, paid: false, defaultBasis: 'not-applicable' })).toMatchObject({
      requests: 0,
      costBasis: 'not-applicable',
      budgetMicros: null,
      budgetRemainingMicros: null,
    });
  });
});

// ───────────────────────────── settings & validation ─────────────────────────────

describe('settings and session validation', () => {
  it('defaults: DEFAULT_LIMITS, normal speed, system motion, default pricing, no players', () => {
    const repo = openRepository(':memory:');
    const s = loadSettings(repo);
    expect(s.defaultLimits).toEqual(DEFAULT_LIMITS);
    expect(s.animationSpeed).toBe('normal');
    expect(s.reduceMotion).toBe('system');
    expect(s.pricing).toEqual(DEFAULT_PRICING);
    expect(s.players).toEqual({});
    repo.close();
  });

  it('merges and persists patches; user pricing is added next to the defaults', () => {
    const repo = openRepository(':memory:');
    const pricing = { inputPerMTokUsd: 1, outputPerMTokUsd: 2, source: 'user' as const };
    saveSettings(repo, { animationSpeed: 'fast', pricing: { 'openai:gpt-x': pricing }, defaultLimits: { maxRounds: 10 } });
    const s = loadSettings(repo);
    expect(s.animationSpeed).toBe('fast');
    expect(s.pricing['openai:gpt-x']).toEqual(pricing);
    expect(Object.keys(s.pricing).length).toBe(Object.keys(DEFAULT_PRICING).length + 1);
    expect(s.defaultLimits.maxRounds).toBe(10);
    repo.close();
  });

  it('rejects unknown keys (e.g. an apiKey smuggled into a player) and bad values', () => {
    const repo = openRepository(':memory:');
    expect(() => saveSettings(repo, { players: { anthropic: { kind: 'anthropic', apiKey: 'sk-ant-xyz' } } })).toThrow(GameError);
    expect(() => saveSettings(repo, { animationSpeed: 'warp' })).toThrow(/Invalid settings/);
    expect(() => saveSettings(repo, { defaultLimits: { minStake: 15 } })).toThrow(/multiple of stakeIncrement/);
    expect(() => validateCreateSessionRequest({ player: { kind: 'anthropic', apiKey: 'x' } })).toThrow(/Invalid session request/);
    expect(() => validateCreateSessionRequest({ player: { kind: 'ollama', baseUrl: 'http://user:pw@host' } })).toThrow(GameError);
    repo.close();
  });

  it('validateLimits enforces positive integers and consistent increments', () => {
    expect(validateLimits({ ...DEFAULT_LIMITS })).toEqual(DEFAULT_LIMITS);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, minStake: 0 })).toThrow(GameError);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, maxRounds: 1.5 })).toThrow(GameError);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, stakeIncrement: 30 })).toThrow(/minStake \(10\) must be a multiple/);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, maxStakePerBet: 5, minStake: 10 })).toThrow(GameError);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, extra: 1 })).toThrow(GameError);
    expect(validateLimits({ ...DEFAULT_LIMITS, maxRounds: null, maxRuntimeSec: null, budgetMicros: null }).maxRounds).toBeNull();
  });
});

// ───────────────────────────── registry ─────────────────────────────

describe('resolveProviderConfig (secrets only from server config)', () => {
  const config = testConfig({
    openai: { apiKey: 'sk-openai-FIXTURE-000000000000', baseUrl: 'https://api.example.test/v1', model: 'env-model' },
    laya: { baseUrl: 'http://127.0.0.1:8000', apiKey: 'laya-FIXTURE-key', checkpoint: 'english' },
  });

  it('never copies secret-looking fields from the request', () => {
    const player = { kind: 'anthropic', model: 'claude-x', apiKey: 'attacker', cliPath: 'C:\\evil.exe', useSubscriptionAuth: false } as never;
    const cfg = resolveProviderConfig('anthropic', player, config);
    expect(cfg.apiKey).toBe(FAKE_ANTHROPIC_KEY);
    expect(cfg.cliPath).toBeUndefined();
    expect(cfg.useSubscriptionAuth).toBeUndefined();
    const cli = resolveProviderConfig('claude-cli', player, config);
    expect(cli.cliPath).toBeUndefined();
    expect(cli.useSubscriptionAuth).toBe(true);
    expect(cli.apiKey).toBeUndefined(); // subscription auth: no key handed to the CLI
  });

  it('keeps the Anthropic endpoint server-side so the key cannot be redirected', () => {
    const cfg = resolveProviderConfig('anthropic', { kind: 'anthropic', baseUrl: 'https://evil.example' }, config);
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
  });

  it('attaches the OpenAI-compatible / Laya key only for the configured endpoint', () => {
    expect(resolveProviderConfig('openai', { kind: 'openai' }, config)).toMatchObject({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-openai-FIXTURE-000000000000',
      model: 'env-model',
    });
    expect(resolveProviderConfig('openai', { kind: 'openai', baseUrl: 'https://api.example.test/v1/' }, config).apiKey).toBeDefined();
    expect(resolveProviderConfig('openai', { kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' }, config).apiKey).toBeUndefined();
    expect(resolveProviderConfig('laya', { kind: 'laya', baseUrl: 'http://127.0.0.1:9999' }, config).apiKey).toBeUndefined();
    expect(resolveProviderConfig('laya', { kind: 'laya' }, config)).toMatchObject({ apiKey: 'laya-FIXTURE-key', layaCheckpoint: 'english' });
    expect(sameEndpoint('HTTP://Host:1/x/', 'http://host:1/x')).toBe(true);
  });

  it('fills non-secret defaults from server config', () => {
    expect(resolveProviderConfig('ollama', { kind: 'ollama' }, config)).toEqual({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    expect(resolveProviderConfig('ollama', { kind: 'ollama', model: ' llama3 ' }, config).model).toBe('llama3');
  });
});
