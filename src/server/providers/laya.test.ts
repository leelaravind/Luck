/**
 * FIXTURE TESTS for the Laya adapter. Laya is NOT installed here: every call goes to a mock
 * laya-serve (node:http on an ephemeral 127.0.0.1 port) that returns hand-written responses in
 * the documented shape. No real classification is performed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type GameObservation } from '../../shared/contracts.js';
import type { DecisionRequest, ResolvedProviderConfig } from '../types.js';
import {
  LAYA_CAPABILITIES,
  LAYA_CRITERIA,
  LAYA_INSTRUCTIONS,
  buildLayaRequestBody,
  buildLayaState,
  createLayaAdapter,
  layaLabelToDecision,
} from './laya.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

type Handler = (seen: Seen, res: http.ServerResponse) => void;

let server: http.Server | null = null;
const seen: Seen[] = [];

async function mockLaya(handler: Handler): Promise<string> {
  seen.length = 0;
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function layaAnswer(choice: string, probabilities: Record<string, number>) {
  return {
    model: 'english',
    answers: { action: { choice, probabilities, confidence: probabilities[choice] ?? 0.5 } },
    usage: { input_tokens: 57, output_tokens: 0 },
    routing: { model: 'english', repo: 'convaiinnovations/laya/english', reason: 'latin script' },
  };
}

const OBS: GameObservation = {
  schemaVersion: 1,
  game: 'european-roulette-single-zero',
  roundNumber: 3,
  balance: 99_980,
  units: 'credit subunits (100 = 1 virtual credit)',
  limits: {
    minStake: 10,
    stakeIncrement: 10,
    maxStakePerBet: 10_000,
    maxStakePerRound: 20_000,
    maxBetsPerRound: 10,
    roundsRemaining: 48,
  },
  betTypes: [],
  rules: [],
  history: [
    { round: 1, winningNumber: 17, color: 'black', yourBets: [{ type: 'red', stake: 10 }], yourTotalStake: 10, yourNet: -10 },
    { round: 2, winningNumber: 0, color: 'green', yourBets: [{ type: 'odd', stake: 10 }], yourTotalStake: 10, yourNet: -10 },
  ],
  stats: { roundsPlayed: 2, netResult: -20 },
};

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    observation: OBS,
    systemPrompt: 'unused by Laya',
    userPrompt: 'unused by Laya',
    jsonSchema: {},
    model: undefined,
    maxOutputTokens: DEFAULT_LIMITS.maxOutputTokens,
    timeoutMs: 5_000,
    maxBudgetUsd: null,
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

describe('laya adapter (mock laya-serve fixture)', () => {
  it('capabilities are honest for a local classifier', () => {
    expect(LAYA_CAPABILITIES).toMatchObject({
      kind: 'laya',
      local: true,
      paid: false,
      generatesText: false,
      reportsTokenUsage: 'input-only',
      reportsCost: false,
      listsModels: false,
      structuredOutput: true,
      quotaInfo: 'none',
    });
    expect(LAYA_CAPABILITIES.notes.join(' ')).toMatch(/no generated text/);
    expect(LAYA_CAPABILITIES.notes.join(' ')).toMatch(/cannot predict outcomes/);
    expect(LAYA_CAPABILITIES.notes.join(' ')).toMatch(/LAYA_HOST=127\.0\.0\.1/);
    expect(Object.keys(LAYA_CRITERIA).length).toBeLessThanOrEqual(20);
  });

  it('testConnection reads /health', async () => {
    const baseUrl = await mockLaya((s, res) => {
      if (s.url === '/health') json(res, 200, { status: 'ok', loaded: ['english'], device: 'cpu' });
      else json(res, 404, { detail: 'Not Found' });
    });
    const t = await createLayaAdapter().testConnection({ kind: 'laya', baseUrl }, signal());
    expect(t.ok).toBe(true);
    expect(t.message).toContain('device cpu');
    expect(t.message).toContain('english');
    expect(t.message).toContain('no classification was run');
    expect(t.models).toEqual(['english']);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/health' });
  });

  it('testConnection reports a server that is not laya-serve', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 404, { detail: 'Not Found' }));
    const t = await createLayaAdapter().testConnection({ kind: 'laya', baseUrl }, signal());
    expect(t.ok).toBe(false);
  });

  it('testConnection reports an unreachable server as not ok', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, {}));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const t = await createLayaAdapter().testConnection({ kind: 'laya', baseUrl }, signal());
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/unreachable/);
  });

  it('decide sends the state + choice question and maps "red" to one min-stake bet', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, layaAnswer('red', { red: 0.31, black: 0.29, skip: 0.2, dozen_1: 0.2 })));
    const cfg: ResolvedProviderConfig = { kind: 'laya', baseUrl, layaCheckpoint: 'english' };
    const r = await createLayaAdapter().decide(request(), cfg, signal());
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.structured).toEqual({
      action: 'bet',
      bets: [{ type: 'red', stake: 10 }],
      explanation:
        "Laya classifier chose 'red' (label probability 0.31, Laya confidence 0.31; raw, uncalibrated). Stake fixed at the session minimum by the adapter.",
    });
    expect(r.usage).toEqual({ inputTokens: 57, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, known: true });
    expect(r.providerCostUsd).toBeNull();
    expect(r.generationMs).toBeNull();
    expect(r.modelReported).toBe('english');
    expect(r.text).toContain('"answers"');
    expect(r.note).toContain('top labels: red 0.31');

    const req = seen[0];
    expect(req).toMatchObject({ method: 'POST', url: '/v1/systemone' });
    const body = req.body as { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
    expect(body.model).toBe('english');
    expect(body.state).toContain('Balance: 99980');
    expect(body.state).toContain('round 3');
    expect(body.state).toContain('17 black, 0 green');
    expect(body.questions.action.type).toBe('choice');
    expect(body.questions.action.instructions).toBe(LAYA_INSTRUCTIONS);
    expect(Object.keys(body.questions.action.criteria)).toEqual(Object.keys(LAYA_CRITERIA));
    expect(req.headers.authorization).toBeUndefined();
  });

  it('maps every label deterministically', () => {
    expect(layaLabelToDecision('dozen_2', 10, 'x')).toEqual({ action: 'bet', bets: [{ type: 'dozen', index: 2, stake: 10 }], explanation: 'x' });
    expect(layaLabelToDecision('column_3', 20, 'x')).toEqual({ action: 'bet', bets: [{ type: 'column', index: 3, stake: 20 }], explanation: 'x' });
    expect(layaLabelToDecision('low', 10, 'x')).toEqual({ action: 'bet', bets: [{ type: 'low', stake: 10 }], explanation: 'x' });
    expect(layaLabelToDecision('skip', 10, 'x')).toEqual({ action: 'skip', explanation: 'x' });
    // "stop" is not offered to Laya, so it must never map to a decision (user/limits end sessions).
    expect(layaLabelToDecision('stop', 10, 'x')).toBeNull();
    expect(Object.keys(LAYA_CRITERIA)).not.toContain('stop');
    expect(layaLabelToDecision('green', 10, 'x')).toBeNull();
    expect(layaLabelToDecision('toString', 10, 'x')).toBeNull();
    for (const label of Object.keys(LAYA_CRITERIA)) expect(layaLabelToDecision(label, 10, 'x'), label).not.toBeNull();
  });

  it('reports a missing confidence honestly instead of substituting the label probability (model-card fields)', async () => {
    const body = layaAnswer('black', { black: 0.4, red: 0.3, skip: 0.2, stop: 0.1 });
    const action = (body.answers as { action: Record<string, unknown> }).action;
    delete action.confidence;
    action.action = { act_probability: 1.0 }; // model card: carries no usable signal — must be ignored
    const baseUrl = await mockLaya((_s, res) => json(res, 200, body));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(r.ok).toBe(true);
    const explanation = (r.structured as { explanation: string }).explanation;
    expect(explanation).toContain('label probability 0.40');
    expect(explanation).toContain('confidence not reported');
    expect(explanation).not.toContain('act_probability');
    expect(explanation).not.toContain('1.00');
  });

  it('skip keeps the explanation free of a stake note', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, layaAnswer('skip', { skip: 0.6, red: 0.4 })));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(r.structured).toEqual({
      action: 'skip',
      explanation: "Laya classifier chose 'skip' (label probability 0.60, Laya confidence 0.60; raw, uncalibrated).",
    });
    expect((seen[0].body as Record<string, unknown>).model).toBeUndefined();
  });

  it('unknown label → invalid_output (never converted)', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, layaAnswer('straight_17', { straight_17: 0.9 })));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_output');
    expect(r.structured).toBeUndefined();
    expect(r.usage.inputTokens).toBe(57);
  });

  it('missing answers → invalid_output', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, { model: 'english', usage: { input_tokens: 5, output_tokens: 0 } }));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(r.error?.code).toBe('invalid_output');
  });

  it('usage without input_tokens is flagged unknown; output tokens are never reported as 0', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, { ...layaAnswer('red', { red: 1 }), usage: undefined }));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(r.ok).toBe(true);
    expect(r.usage.known).toBe(false);
    expect(r.usage.outputTokens).toBeNull();
  });

  it('sends Authorization: Bearer when LAYA_API_KEY is configured and keeps it out of errors', async () => {
    const key = 'laya-fixture-secret-123';
    const baseUrl = await mockLaya((s, res) => {
      if (s.headers.authorization === `Bearer ${key}`) json(res, 500, { detail: `boom ${key}` });
      else json(res, 401, { detail: 'unauthorized' });
    });
    const adapter = createLayaAdapter();
    const r = await adapter.decide(request(), { kind: 'laya', baseUrl, apiKey: key }, signal());
    expect(seen[0].headers.authorization).toBe(`Bearer ${key}`);
    expect(r.error?.code).toBe('server_error');
    expect(r.error?.message).not.toContain(key);
    expect(r.text ?? '').not.toContain(key);

    const r2 = await adapter.decide(request(), { kind: 'laya', baseUrl }, signal());
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(r2.error?.code).toBe('auth');
  });

  it('timeout and abort are reported, not thrown', async () => {
    const baseUrl = await mockLaya(() => {
      /* never answers */
    });
    const adapter = createLayaAdapter();
    const r = await adapter.decide(request({ timeoutMs: 300 }), { kind: 'laya', baseUrl }, signal());
    expect(r.error).toMatchObject({ code: 'timeout', retryable: true });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r2 = await adapter.decide(request({ timeoutMs: 10_000 }), { kind: 'laya', baseUrl }, ac.signal);
    expect(r2.error?.code).toBe('cancelled');
  });

  it('check(): invalid URL is not configured; a non-loopback URL is flagged', () => {
    const a = createLayaAdapter();
    expect(a.check({ kind: 'laya', baseUrl: 'ftp://127.0.0.1:8000' }).configured).toBe(false);
    expect(a.check({ kind: 'laya', baseUrl: 'http://user:pw@127.0.0.1:8000' }).configured).toBe(false);
    const remote = a.check({ kind: 'laya', baseUrl: 'http://192.168.1.20:8000' });
    expect(remote.configured).toBe(true);
    expect(remote.issues.join(' ')).toMatch(/loopback/);
    expect(a.check({ kind: 'laya', baseUrl: 'http://127.0.0.1:8000' })).toEqual({ configured: true, enabled: true, issues: [] });
    expect(a.check({ kind: 'laya', layaCheckpoint: '../../etc' }).issues.length).toBe(1);
  });

  it('state summary is built only from the observation', () => {
    const s = buildLayaState(OBS);
    expect(s).toContain('Minimum stake 10');
    expect(s).toContain('Rounds remaining: 48');
    expect(s).toContain('net -10');
    // No house-edge / predictability commentary in model-facing text (user request).
    expect(s).not.toMatch(/house edge|cannot be predicted|independent/i);
  });

  // Everything Laya sees is the request body: state + question instructions + criteria.
  const COMMENTARY = /house[ -]?edge|edge|cannot be predicted|unpredictable|predict|random|chance|independent|odds|expected (value|loss)|luck/i;

  it('the WHOLE request body carries no house-edge / randomness / predictability commentary', () => {
    const body = buildLayaRequestBody(OBS, 'english');
    expect(JSON.stringify(body)).not.toMatch(COMMENTARY);
    expect(JSON.stringify(buildLayaRequestBody({ ...OBS, history: [], stats: { roundsPlayed: 0, netResult: 0 } }, undefined))).not.toMatch(COMMENTARY);
    expect(LAYA_INSTRUCTIONS).toBe('Choose the next action in a virtual European roulette game.');
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
  });

  it('the body actually sent by decide() is exactly buildLayaRequestBody and is free of that commentary', async () => {
    const baseUrl = await mockLaya((_s, res) => json(res, 200, layaAnswer('skip', { skip: 0.6, red: 0.4 })));
    const r = await createLayaAdapter().decide(request(), { kind: 'laya', baseUrl, layaCheckpoint: 'english' }, signal());
    expect(r.ok).toBe(true);
    expect(seen[0].body).toEqual(buildLayaRequestBody(OBS, 'english'));
    expect(JSON.stringify(seen[0].body)).not.toMatch(COMMENTARY);
  });
});
