import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameError, type GameObservation } from '../../shared/contracts.js';
import { PLAYER_DECISION_JSON_SCHEMA, parseDecision } from '../../shared/decision.js';
import type { DecisionRequest, ResolvedProviderConfig } from '../types.js';
import { createOpenAIAdapter, mapOpenAIUsage } from './openai.js';
import { closedPortUrl, neverAborted, startMockServer, type MockResponse, type MockServer } from './__tests__/mockHttp.js';

/** FIXTURE key — not a real credential. */
const KEY = 'fixture-openai-key-abcdef0123456789';
const adapter = createOpenAIAdapter();

const request = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  observation: { schemaVersion: 1 } as unknown as GameObservation,
  systemPrompt: 'Reply with ONE JSON object.',
  userPrompt: 'observation',
  jsonSchema: PLAYER_DECISION_JSON_SCHEMA,
  model: 'fixture-model',
  maxOutputTokens: 300,
  timeoutMs: 2000,
  maxBudgetUsd: 0.25,
  ...over,
});

/** Chat Completions response shape with FIXTURE values. */
const completion = (content: string | null, over: { finish?: string; usage?: unknown; message?: Record<string, unknown> } = {}): MockResponse => ({
  headers: {
    'x-ratelimit-limit-requests': '500',
    'x-ratelimit-remaining-requests': '499',
    'x-ratelimit-reset-requests': '120ms',
    'x-ratelimit-limit-tokens': '30000',
    'x-ratelimit-remaining-tokens': '29000',
    'x-ratelimit-reset-tokens': '2s',
  },
  body: {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    model: 'fixture-model-2026',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(over.message ?? {}) }, finish_reason: over.finish ?? 'stop' }],
    usage:
      over.usage === undefined
        ? {
            prompt_tokens: 1000,
            completion_tokens: 90,
            total_tokens: 1090,
            prompt_tokens_details: { cached_tokens: 600 },
            completion_tokens_details: { reasoning_tokens: 40 },
          }
        : over.usage,
  },
});

describe('OpenAI-compatible adapter (FIXTURE: local mock server / stubbed fetch, no real API calls)', () => {
  let server: MockServer | null = null;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = null;
  });
  const cfg = (over: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig => ({
    kind: 'openai',
    baseUrl: `${server!.baseUrl}/v1`,
    apiKey: KEY,
    model: 'fixture-model',
    ...over,
  });

  it('capabilities: explicit endpoint, JSON mode is not schema-constrained', () => {
    expect(adapter.capabilities).toMatchObject({
      kind: 'openai',
      paid: true,
      structuredOutput: false,
      reportsTokenUsage: 'full',
      reportsCost: false,
      listsModels: true,
      quotaInfo: 'rate-limit-headers',
      requiresApiKey: false,
    });
  });

  it('check(): endpoint required; key required for api.openai.com, optional on loopback, warned elsewhere', () => {
    const none = adapter.check({ kind: 'openai' });
    expect(none.configured).toBe(false);
    expect(none.issues.join()).toMatch(/No endpoint set/);
    expect(none.issues.join()).toMatch(/No model set/);

    const openaiNoKey = adapter.check({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm' });
    expect(openaiNoKey.configured).toBe(false);
    expect(openaiNoKey.issues.join()).toMatch(/OPENAI_API_KEY/);

    expect(adapter.check({ kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'm' })).toEqual({
      configured: true,
      enabled: true,
      issues: [],
    });
    const remoteNoKey = adapter.check({ kind: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'm' });
    expect(remoteNoKey.configured).toBe(true);
    expect(remoteNoKey.issues.join()).toMatch(/No API key set/);
  });

  it('decide(): POSTs chat/completions with JSON mode and max_tokens on a non-OpenAI host; maps usage and headers', async () => {
    server = await startMockServer(() => completion('{"action":"bet","bets":[{"type":"corner","numbers":[1,2,4,5],"stake":40}]}'));
    const r = await adapter.decide(request({ temperature: 0.7 }), cfg(), neverAborted());

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.json).toEqual({
      model: 'fixture-model',
      messages: [
        { role: 'system', content: 'Reply with ONE JSON object.' },
        { role: 'user', content: 'observation' },
      ],
      response_format: { type: 'json_object' },
      stream: false,
      max_tokens: 300,
      temperature: 0.7,
    });

    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({
      inputTokens: 400,
      outputTokens: 90,
      cacheReadTokens: 600,
      cacheWriteTokens: null,
      reasoningTokens: 40,
      known: true,
    });
    expect(r.modelReported).toBe('fixture-model-2026');
    expect(r.finishReason).toBe('stop');
    expect(r.rateLimit?.entries.map((e) => e.name)).toEqual(['requests', 'tokens']);
    expect(r.rateLimit?.entries[0]).toMatchObject({ limit: 500, remaining: 499 });
    expect(parseDecision(r)).toEqual({
      ok: true,
      decision: { action: 'bet', bets: [{ type: 'corner', numbers: [1, 2, 4, 5], stake: 40 }] },
    });
  });

  it('decide(): no Authorization header when no key (local server)', async () => {
    server = await startMockServer(() => completion('{"action":"skip"}'));
    await adapter.decide(request(), cfg({ apiKey: undefined }), neverAborted());
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(server.requests[0]!.json).not.toHaveProperty('temperature');
  });

  it('decide(): uses max_completion_tokens for api.openai.com (stubbed fetch, nothing leaves the machine)', async () => {
    let captured: { url: string; body: any } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(completion('{"action":"skip"}').body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await adapter.decide(
      request(),
      { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY, model: 'fixture-model' },
      neverAborted(),
    );
    expect(r.ok).toBe(true);
    expect(captured!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured!.body.max_completion_tokens).toBe(300);
    expect(captured!.body).not.toHaveProperty('max_tokens');
  });

  it('decide(): api.openai.com without a key → not_configured, no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await adapter.decide(request(), { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm' }, neverAborted());
    expect(r.error?.code).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('decide(): <think> + fences parse; extra keys and malformed JSON are rejected by parseDecision', async () => {
    server = await startMockServer(() => completion('<think>ok</think>\n```\n{"action":"skip"}\n```'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted()))).toEqual({ ok: true, decision: { action: 'skip' } });
    server.setHandler(() => completion('{"action":"skip","bonus":true}'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted())).ok).toBe(false);
    server.setHandler(() => completion('{action: skip}'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted())).ok).toBe(false);
  });

  it('decide(): finish_reason length → invalid_output hint; refusal → invalid_output', async () => {
    server = await startMockServer(() => completion('{"action":"bet"', { finish: 'length' }));
    const a = await adapter.decide(request(), cfg(), neverAborted());
    expect(a.error?.code).toBe('invalid_output');
    expect(a.error?.message).toMatch(/raise max output tokens/);
    server.setHandler(() => completion(null, { message: { refusal: 'I cannot help with that.' } }));
    const b = await adapter.decide(request(), cfg(), neverAborted());
    expect(b.error?.code).toBe('invalid_output');
    expect(b.error?.message).toMatch(/refused/);
  });

  it('decide(): missing usage → known:false (never invented)', async () => {
    server = await startMockServer(() => completion('{"action":"skip"}', { usage: null }));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      known: false,
    });
  });

  it('decide(): 429 Retry-After seconds / HTTP-date and headers on the error', async () => {
    server = await startMockServer(() => ({
      status: 429,
      headers: { 'retry-after': '5', 'x-ratelimit-remaining-requests': '0' },
      body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } },
    }));
    const a = await adapter.decide(request(), cfg(), neverAborted());
    expect(a.error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 5000, httpStatus: 429 });
    expect(a.rateLimit?.entries).toEqual([{ name: 'requests', remaining: 0 }]);

    server.setHandler(() => ({ status: 429, headers: { 'retry-after': new Date(Date.now() + 6000).toUTCString() }, body: {} }));
    const b = await adapter.decide(request(), cfg(), neverAborted());
    expect(b.error!.retryAfterMs).toBeGreaterThan(3000);
    expect(b.error!.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it.each([
    [500, 'server_error', true],
    [529, 'server_error', true],
    [401, 'auth', false],
    [400, 'bad_request', false],
  ])('decide(): HTTP %i → %s', async (status, code, retryable) => {
    server = await startMockServer(() => ({ status, body: { error: { message: `fixture ${status} (key ${KEY})` } } }));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error).toMatchObject({ code, retryable, httpStatus: status });
    expect(r.error?.message).toContain(`fixture ${status}`);
    expect(r.error?.message).not.toContain(KEY);
    expect(r.text).toBeNull(); // the raw (unredacted) error body is never passed on as model text
  });

  it('decide(): timeout, caller abort, closed port', async () => {
    server = await startMockServer(() => ({ ...completion('{"action":"skip"}'), delayMs: 3000 }));
    const t = await adapter.decide(request({ timeoutMs: 250 }), cfg(), neverAborted());
    expect(t.error).toMatchObject({ code: 'timeout', retryable: true });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const c = await adapter.decide(request({ timeoutMs: 5000 }), cfg(), ac.signal);
    expect(c.error).toMatchObject({ code: 'cancelled', retryable: false });

    const url = await closedPortUrl();
    const u = await adapter.decide(request(), { kind: 'openai', baseUrl: `${url}/v1`, model: 'm' }, neverAborted());
    expect(u.error).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('listModels() and testConnection(): GET {baseUrl}/models', async () => {
    server = await startMockServer(() => ({ body: { object: 'list', data: [{ id: 'zeta' }, { id: 'alpha' }] } }));
    expect(await adapter.listModels!(cfg(), neverAborted())).toEqual(['alpha', 'zeta']);
    expect(server.requests[0]!.url).toBe('/v1/models');
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const t = await adapter.testConnection(cfg(), neverAborted());
    expect(t.ok).toBe(true);
    expect(t.models).toEqual(['alpha', 'zeta']);
    expect(typeof t.latencyMs).toBe('number');
  });

  it('listModels(): failure throws GameError; testConnection returns ok:false', async () => {
    server = await startMockServer(() => ({ status: 404, body: { error: 'no such route' } }));
    await expect(adapter.listModels!(cfg(), neverAborted())).rejects.toBeInstanceOf(GameError);
    const t = await adapter.testConnection(cfg(), neverAborted());
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/404/);
  });
});

describe('mapOpenAIUsage (pure)', () => {
  it('splits cached tokens out of prompt_tokens and keeps reasoning as a subset of output', () => {
    expect(
      mapOpenAIUsage({
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 4 },
      }),
    ).toEqual({ inputTokens: 30, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: null, reasoningTokens: 4, known: true });
  });
  it('without details → cache/reasoning null', () => {
    expect(mapOpenAIUsage({ prompt_tokens: 5, completion_tokens: 1 })).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      known: true,
    });
  });
});
