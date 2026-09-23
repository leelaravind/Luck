import { afterEach, describe, expect, it } from 'vitest';
import { GameError, type GameObservation } from '../../shared/contracts.js';
import { PLAYER_DECISION_JSON_SCHEMA, parseDecision } from '../../shared/decision.js';
import type { DecisionRequest } from '../types.js';
import { createOllamaAdapter } from './ollama.js';
import { closedPortUrl, neverAborted, startMockServer, type MockResponse, type MockServer } from './__tests__/mockHttp.js';

const adapter = createOllamaAdapter();

const request = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({
  observation: { schemaVersion: 1 } as unknown as GameObservation,
  systemPrompt: 'SYSTEM: reply with one JSON object',
  userPrompt: 'USER: observation',
  jsonSchema: PLAYER_DECISION_JSON_SCHEMA,
  model: 'llama3.2:3b',
  maxOutputTokens: 256,
  timeoutMs: 2000,
  maxBudgetUsd: null,
  ...over,
});

/** A realistic /api/chat response shape (FIXTURE values). */
const chat = (content: string, extra: Record<string, unknown> = {}): MockResponse => ({
  body: {
    model: 'llama3.2:3b',
    created_at: '2026-09-23T12:00:00Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    total_duration: 900_000_000,
    load_duration: 12_000_000,
    prompt_eval_count: 812,
    prompt_eval_duration: 150_000_000,
    eval_count: 34,
    eval_duration: 680_000_000,
    ...extra,
  },
});

describe('Ollama adapter (FIXTURE: local mock HTTP server, no real Ollama)', () => {
  let server: MockServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const cfg = () => ({ kind: 'ollama' as const, baseUrl: server!.baseUrl, model: 'llama3.2:3b' });

  it('capabilities are honest about local inference', () => {
    expect(adapter.kind).toBe('ollama');
    expect(adapter.capabilities).toMatchObject({
      local: true,
      paid: false,
      reportsTokenUsage: 'full',
      reportsCost: false,
      listsModels: true,
      structuredOutput: true,
      quotaInfo: 'none',
      requiresApiKey: false,
    });
    expect(adapter.capabilities.notes[0]).toMatch(/no cloud inference charge/i);
  });

  it('check(): valid URL is configured; missing model and bad URL are reported', () => {
    expect(adapter.check({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'x' })).toEqual({
      configured: true,
      enabled: true,
      issues: [],
    });
    const noModel = adapter.check({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    expect(noModel.configured).toBe(true);
    expect(noModel.issues.join()).toMatch(/No model selected/);
    expect(adapter.check({ kind: 'ollama', baseUrl: 'nope' }).configured).toBe(false);
  });

  it('decide(): sends /api/chat with format schema, options, and maps usage + timing', async () => {
    server = await startMockServer(() => chat('{"action":"bet","bets":[{"type":"red","stake":100}],"explanation":"red"}'));
    const r = await adapter.decide(request({ temperature: 0.2 }), cfg(), neverAborted());

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/api/chat');
    expect(sent.json).toEqual({
      model: 'llama3.2:3b',
      stream: false,
      format: PLAYER_DECISION_JSON_SCHEMA,
      messages: [
        { role: 'system', content: 'SYSTEM: reply with one JSON object' },
        { role: 'user', content: 'USER: observation' },
      ],
      options: { num_predict: 256, temperature: 0.2 },
    });

    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.usage).toEqual({
      inputTokens: 812,
      outputTokens: 34,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      known: true,
    });
    expect(r.generationMs).toBe(680);
    expect(r.finishReason).toBe('stop');
    expect(r.modelReported).toBe('llama3.2:3b');
    expect(r.providerCostUsd).toBeNull();
    expect(r.rateLimit).toBeNull();
    expect(parseDecision(r)).toEqual({
      ok: true,
      decision: { action: 'bet', bets: [{ type: 'red', stake: 100 }], explanation: 'red' },
    });
  });

  it('decide(): omits temperature when not set; model from cfg when req.model is undefined', async () => {
    server = await startMockServer(() => chat('{"action":"skip"}'));
    await adapter.decide(request({ model: undefined }), { ...cfg(), model: 'qwen3:4b' }, neverAborted());
    expect(server.requests[0]!.json.model).toBe('qwen3:4b');
    expect(server.requests[0]!.json.options).toEqual({ num_predict: 256 });
  });

  it('decide(): <think> + fenced output is returned raw and parses', async () => {
    server = await startMockServer(() => chat('<think>hmm</think>\n```json\n{"action":"skip"}\n```'));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.ok).toBe(true);
    expect(parseDecision(r)).toEqual({ ok: true, decision: { action: 'skip' } });
  });

  it('decide(): malformed JSON and extra keys come back as text and are rejected by parseDecision', async () => {
    server = await startMockServer(() => chat('{"action": "skip",'));
    const bad = await adapter.decide(request(), cfg(), neverAborted());
    expect(bad.ok).toBe(true);
    expect(parseDecision(bad).ok).toBe(false);

    server.setHandler(() => chat('{"action":"skip","mood":"lucky"}'));
    const extra = await adapter.decide(request(), cfg(), neverAborted());
    const parsed = parseDecision(extra);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join()).toMatch(/mood/);
  });

  it('decide(): done_reason "length" → invalid_output with a raise-max-tokens hint', async () => {
    server = await startMockServer(() => chat('{"action":"bet","bets":[', { done_reason: 'length' }));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'invalid_output', retryable: false });
    expect(r.error!.message).toMatch(/raise max output tokens/);
    expect(r.usage.known).toBe(true); // tokens were still spent and reported
  });

  it('decide(): model not installed (404) → bad_request with Ollama message', async () => {
    server = await startMockServer(() => ({ status: 404, body: { error: "model 'nope' not found" } }));
    const r = await adapter.decide(request({ model: 'nope' }), cfg(), neverAborted());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'bad_request', retryable: false, httpStatus: 404 });
    expect(r.error!.message).toContain("model 'nope' not found");
    expect(r.usage.known).toBe(false);
    expect(r.text).toBeNull(); // an error body is not model output
  });

  it.each([
    [500, 'server_error', true],
    [503, 'server_error', true],
    [529, 'server_error', true],
    [401, 'auth', false],
  ])('decide(): HTTP %i → %s', async (status, code, retryable) => {
    server = await startMockServer(() => ({ status, body: { error: 'fixture error' } }));
    const r = await adapter.decide(request(), cfg(), neverAborted());
    expect(r.error).toMatchObject({ code, retryable, httpStatus: status });
  });

  it('decide(): 429 with Retry-After seconds and HTTP-date → rate_limited with retryAfterMs', async () => {
    server = await startMockServer(() => ({ status: 429, headers: { 'retry-after': '3' }, body: { error: 'busy' } }));
    const a = await adapter.decide(request(), cfg(), neverAborted());
    expect(a.error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 3000 });
    server.setHandler(() => ({ status: 429, headers: { 'retry-after': new Date(Date.now() + 8000).toUTCString() }, body: {} }));
    const b = await adapter.decide(request(), cfg(), neverAborted());
    expect(b.error!.retryAfterMs).toBeGreaterThan(5000);
    expect(b.error!.retryAfterMs).toBeLessThanOrEqual(8000);
  });

  it('decide(): server slower than timeoutMs → timeout', async () => {
    server = await startMockServer(() => ({ ...chat('{"action":"skip"}'), delayMs: 3000 }));
    const r = await adapter.decide(request({ timeoutMs: 250 }), cfg(), neverAborted());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'timeout', retryable: true });
    expect(r.usage.known).toBe(false);
  });

  it('decide(): caller abort → cancelled', async () => {
    server = await startMockServer(() => ({ ...chat('{"action":"skip"}'), delayMs: 3000 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await adapter.decide(request({ timeoutMs: 5000 }), cfg(), ac.signal);
    expect(r.error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('decide(): Ollama not running (closed port) → unavailable', async () => {
    const url = await closedPortUrl();
    const r = await adapter.decide(request(), { kind: 'ollama', baseUrl: url, model: 'x' }, neverAborted());
    expect(r.error).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('decide(): no model → not_configured without any request', async () => {
    server = await startMockServer(() => chat('{}'));
    const r = await adapter.decide(request({ model: undefined }), { kind: 'ollama', baseUrl: server.baseUrl }, neverAborted());
    expect(r.error?.code).toBe('not_configured');
    expect(server.requests).toHaveLength(0);
  });

  it('testConnection(): version + installed models + latency', async () => {
    server = await startMockServer((req) =>
      req.url === '/api/version'
        ? { body: { version: '0.12.3' } }
        : { body: { models: [{ name: 'qwen3:4b' }, { name: 'llama3.2:3b' }] } },
    );
    const t = await adapter.testConnection(cfg(), neverAborted());
    expect(t.ok).toBe(true);
    expect(t.version).toBe('0.12.3');
    expect(t.models).toEqual(['llama3.2:3b', 'qwen3:4b']);
    expect(typeof t.latencyMs).toBe('number');
    expect(t.message).toMatch(/Ollama 0\.12\.3 — 2 models installed/);
    expect(server.requests.map((q) => q.url)).toEqual(['/api/version', '/api/tags']);
  });

  it('testConnection(): no models installed → tells the user to pull one', async () => {
    server = await startMockServer((req) => (req.url === '/api/version' ? { body: { version: '0.12.3' } } : { body: { models: [] } }));
    const t = await adapter.testConnection(cfg(), neverAborted());
    expect(t.ok).toBe(true);
    expect(t.message).toMatch(/ollama pull/);
  });

  it('testConnection(): unreachable → ok:false with message, no throw', async () => {
    const url = await closedPortUrl();
    const t = await adapter.testConnection({ kind: 'ollama', baseUrl: url }, neverAborted());
    expect(t.ok).toBe(false);
    expect(t.latencyMs).toBeNull();
    expect(t.message).toMatch(/unreachable/);
  });

  it('listModels(): names from /api/tags; failure throws GameError(provider_unavailable)', async () => {
    server = await startMockServer(() => ({ body: { models: [{ name: 'b:1' }, { name: 'a:2' }, { model: 'c:3' }] } }));
    expect(await adapter.listModels!(cfg(), neverAborted())).toEqual(['a:2', 'b:1', 'c:3']);
    const url = await closedPortUrl();
    await expect(adapter.listModels!({ kind: 'ollama', baseUrl: url }, neverAborted())).rejects.toBeInstanceOf(GameError);
  });
});
