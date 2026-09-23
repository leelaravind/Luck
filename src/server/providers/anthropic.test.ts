import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameError, type GameObservation } from '../../shared/contracts.js';
import { PLAYER_DECISION_JSON_SCHEMA, parseDecision } from '../../shared/decision.js';
import type { DecisionRequest, ResolvedProviderConfig } from '../types.js';
import { createAnthropicAdapter } from './anthropic.js';
import { closedPortUrl, neverAborted, startMockServer, type MockResponse, type MockServer } from './__tests__/mockHttp.js';

/** FIXTURE key — not a real credential. */
const KEY = 'fixture-anthropic-key-0123456789abcdef';
const adapter = createAnthropicAdapter();

const request = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  observation: { schemaVersion: 1 } as unknown as GameObservation,
  systemPrompt: 'SYSTEM prompt',
  userPrompt: 'USER prompt',
  jsonSchema: PLAYER_DECISION_JSON_SCHEMA,
  model: 'claude-sonnet-5',
  maxOutputTokens: 400,
  timeoutMs: 3000,
  maxBudgetUsd: 0.25,
  ...over,
});

/** A Messages API response shape with FIXTURE values. */
const message = (text: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}): MockResponse => ({
  headers: {
    'request-id': 'req_fixture',
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-remaining': '49',
    'anthropic-ratelimit-requests-reset': '2026-09-23T12:00:05Z',
    'anthropic-ratelimit-output-tokens-limit': '8000',
    'anthropic-ratelimit-output-tokens-remaining': '7900',
    ...headers,
  },
  body: {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 60,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
      output_tokens_details: { thinking_tokens: 20 },
    },
    ...over,
  },
});

const apiError = (status: number, type: string, msg: string, headers: Record<string, string> = {}): MockResponse => ({
  status,
  headers,
  body: { type: 'error', error: { type, message: msg }, request_id: 'req_fixture' },
});

describe('Anthropic adapter (FIXTURE: official SDK pointed at a local mock server, no real API calls)', () => {
  let server: MockServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const cfg = (over: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig => ({
    kind: 'anthropic',
    baseUrl: server!.baseUrl,
    apiKey: KEY,
    model: 'claude-sonnet-5',
    ...over,
  });

  it('capabilities: paid, full usage, rate-limit headers, key required', () => {
    expect(adapter.capabilities).toMatchObject({
      kind: 'anthropic',
      local: false,
      paid: true,
      generatesText: true,
      reportsTokenUsage: 'full',
      reportsCost: false,
      listsModels: true,
      structuredOutput: true,
      quotaInfo: 'rate-limit-headers',
      requiresApiKey: true,
    });
  });

  it('check(): missing key → not configured; model optional but reported', () => {
    const c = adapter.check({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    expect(c.configured).toBe(false);
    expect(c.issues.join()).toMatch(/ANTHROPIC_API_KEY/);
    expect(c.issues.join()).toMatch(/No model selected/);
    expect(adapter.check({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: KEY, model: 'm' })).toEqual({
      configured: true,
      enabled: true,
      issues: [],
    });
  });

  it('decide(): sends output_config json_schema, maps usage, stop reason and rate-limit headers', async () => {
    server = await startMockServer(() => message('{"action":"bet","bets":[{"type":"dozen","index":3,"stake":50}]}'));
    const r = await adapter.decide(request(), cfg(), neverAborted());

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-version']).toBeTruthy();
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.json).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system: 'SYSTEM prompt',
      messages: [{ role: 'user', content: 'USER prompt' }],
      output_config: { format: { type: 'json_schema', schema: PLAYER_DECISION_JSON_SCHEMA } },
    });
    expect(sent.json).not.toHaveProperty('output_format');
    expect(sent.json).not.toHaveProperty('temperature');
    expect(sent.json).not.toHaveProperty('stream');

    expect(r.ok).toBe(true);
    expect(r.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 60,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 20,
      known: true,
    });
    expect(r.finishReason).toBe('end_turn');
    expect(r.modelReported).toBe('claude-sonnet-5');
    expect(r.providerCostUsd).toBeNull();
    expect(r.generationMs).toBeNull();
    expect(r.rateLimit?.source).toBe('response-headers');
    expect(r.rateLimit?.entries).toEqual([
      { name: 'output-tokens', limit: 8000, remaining: 7900 },
      { name: 'requests', limit: 50, remaining: 49, resetAt: '2026-09-23T12:00:05.000Z' },
    ]);
    expect(parseDecision(r)).toEqual({ ok: true, decision: { action: 'bet', bets: [{ type: 'dozen', index: 3, stake: 50 }] } });
  });

  it('decide(): ignores ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY in the environment (config key only)', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-should-not-be-sent');
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-should-not-be-sent');
    try {
      server = await startMockServer(() => message('{"action":"skip"}'));
      await adapter.decide(request(), cfg(), neverAborted());
      expect(server.requests[0]!.headers.authorization).toBeUndefined();
      expect(server.requests[0]!.headers['x-api-key']).toBe(KEY);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('decide(): sends temperature only when set', async () => {
    server = await startMockServer(() => message('{"action":"skip"}'));
    await adapter.decide(request({ temperature: 0.3 }), cfg(), neverAborted());
    expect(server.requests[0]!.json.temperature).toBe(0.3);
  });

  it('decide(): <think> + fences in text parse; extra keys and malformed JSON are rejected by parseDecision', async () => {
    server = await startMockServer(() => message('<think>x</think>```json\n{"action":"stop"}\n```'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted()))).toEqual({ ok: true, decision: { action: 'stop' } });
    server.setHandler(() => message('{"action":"stop","secret_plan":1}'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted())).ok).toBe(false);
    server.setHandler(() => message('{"action":'));
    expect(parseDecision(await adapter.decide(request(), cfg(), neverAborted())).ok).toBe(false);
  });

  it('decide(): stop_reason max_tokens → invalid_output with hint, usage still reported', async () => {
    server = await startMockServer(() => message('{"action":"bet","bets":[{"ty', { stop_reason: 'max_tokens' }));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_output');
    expect(r.error?.message).toMatch(/raise max output tokens/);
    expect(r.usage.known).toBe(true);
    expect(r.finishReason).toBe('max_tokens');
  });

  it('decide(): stop_reason refusal → invalid_output', async () => {
    server = await startMockServer(() =>
      message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'fixture' } }),
    );
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error?.code).toBe('invalid_output');
    expect(r.error?.message).toMatch(/refusal/);
  });

  it('decide(): 429 with retry-after seconds → rate_limited + retryAfterMs + headers', async () => {
    server = await startMockServer(() =>
      apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit', {
        'retry-after': '7',
        'anthropic-ratelimit-requests-remaining': '0',
      }),
    );
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 7000, httpStatus: 429 });
    expect(r.error?.message).toMatch(/exceeded your rate limit/);
    expect(r.rateLimit?.entries).toEqual([{ name: 'requests', remaining: 0 }]);
    expect(server.requests).toHaveLength(1); // SDK retries disabled
  });

  it('decide(): 429 with retry-after HTTP-date', async () => {
    server = await startMockServer(() =>
      apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': new Date(Date.now() + 9000).toUTCString() }),
    );
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error?.code).toBe('rate_limited');
    expect(r.error!.retryAfterMs).toBeGreaterThan(6000);
    expect(r.error!.retryAfterMs).toBeLessThanOrEqual(9000);
  });

  it.each([
    [529, 'overloaded_error', 'server_error', true],
    [500, 'api_error', 'server_error', true],
    [401, 'authentication_error', 'auth', false],
    [403, 'permission_error', 'auth', false],
    [400, 'invalid_request_error', 'bad_request', false],
    [404, 'not_found_error', 'bad_request', false],
  ])('decide(): HTTP %i %s → %s', async (status, type, code, retryable) => {
    server = await startMockServer(() => apiError(status, type, `fixture ${type}`));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code, retryable, httpStatus: status });
    expect(r.error?.message).toContain(`fixture ${type}`);
    expect(server.requests).toHaveLength(1);
  });

  it('decide(): a key echoed in an error message is redacted', async () => {
    server = await startMockServer(() => apiError(401, 'authentication_error', `invalid x-api-key ${KEY}`));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error?.code).toBe('auth');
    expect(r.error?.message).not.toContain(KEY);
  });

  it('decide(): slow server → timeout (deadline also covers a stalled body)', async () => {
    server = await startMockServer(() => ({ ...message('{"action":"skip"}'), delayMs: 3000 }));
    const a = await adapter.decide(request({ timeoutMs: 300 }), cfg(), neverAborted());
    expect(a.error).toMatchObject({ code: 'timeout', retryable: true });
    server.setHandler(() => ({ ...message('{"action":"skip"}'), stallBodyMs: 3000 }));
    const b = await adapter.decide(request({ timeoutMs: 300 }), cfg(), neverAborted());
    expect(b.error?.code).toBe('timeout');
  });

  it('decide(): caller abort → cancelled', async () => {
    server = await startMockServer(() => ({ ...message('{"action":"skip"}'), delayMs: 3000 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await adapter.decide(request({ timeoutMs: 5000 }), cfg(), ac.signal);
    expect(r.error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('decide(): closed port → unavailable', async () => {
    const url = await closedPortUrl();
    const r = await adapter.decide(request(), { kind: 'anthropic', baseUrl: url, apiKey: KEY, model: 'm' }, neverAborted());
    expect(r.error).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('decide(): no key or no model → not_configured, no request sent', async () => {
    server = await startMockServer(() => message('{}'));
    expect((await adapter.decide(request(), cfg({ apiKey: undefined }), neverAborted())).error?.code).toBe('not_configured');
    expect((await adapter.decide(request({ model: undefined }), cfg({ model: undefined }), neverAborted())).error?.code).toBe(
      'not_configured',
    );
    expect(server.requests).toHaveLength(0);
  });

  it('listModels(): follows pagination and returns ids', async () => {
    server = await startMockServer((req) => {
      const page2 = req.url.includes('after_id=');
      return {
        body: {
          data: page2
            ? [{ id: 'claude-haiku-4-5', type: 'model', display_name: 'Haiku', created_at: '2025-10-01T00:00:00Z' }]
            : [
                { id: 'claude-opus-5', type: 'model', display_name: 'Opus', created_at: '2026-01-01T00:00:00Z' },
                { id: 'claude-sonnet-5', type: 'model', display_name: 'Sonnet', created_at: '2026-01-01T00:00:00Z' },
              ],
          has_more: !page2,
          first_id: page2 ? 'claude-haiku-4-5' : 'claude-opus-5',
          last_id: page2 ? 'claude-haiku-4-5' : 'claude-sonnet-5',
        },
      };
    });
    expect(await adapter.listModels!(cfg(), neverAborted())).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    expect(server.requests[0]!.url).toMatch(/^\/v1\/models\?/);
    expect(server.requests[0]!.headers['x-api-key']).toBe(KEY);
    expect(server.requests).toHaveLength(2);
  });

  it('listModels(): auth failure throws GameError(provider_unavailable)', async () => {
    server = await startMockServer(() => apiError(401, 'authentication_error', 'bad key'));
    const err = await adapter.listModels!(cfg(), neverAborted()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe('provider_unavailable');
    expect((err as GameError).details).toEqual({ code: 'auth' });
  });

  it('testConnection(): lists models (no tokens spent) and measures latency', async () => {
    server = await startMockServer(() => ({
      body: { data: [{ id: 'claude-sonnet-5', type: 'model' }], has_more: false, first_id: 'claude-sonnet-5', last_id: 'claude-sonnet-5' },
    }));
    const t = await adapter.testConnection(cfg(), neverAborted());
    expect(t.ok).toBe(true);
    expect(t.models).toEqual(['claude-sonnet-5']);
    expect(t.message).toMatch(/no tokens spent/);
    expect(typeof t.latencyMs).toBe('number');
    expect(server.requests.every((q) => q.method === 'GET')).toBe(true);
  });

  it('testConnection(): without a key it fails fast and makes no request', async () => {
    server = await startMockServer(() => ({ body: {} }));
    const t = await adapter.testConnection(cfg({ apiKey: '' }), neverAborted());
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(server.requests).toHaveLength(0);
  });
});
