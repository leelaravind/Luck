// Unit tests for the typed API client with a mocked fetch (no network, no server).
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';
import { parseServerEvent } from './events';

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status: number; body?: unknown; raw?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe('api client', () => {
  it('sends X-Luck-Client on every request and JSON content type with bodies', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: true, version: '0.1.0' } }, { status: 200, body: {} }]);
    const api = createApiClient({ fetch: fn });
    await api.health();
    await api.updateSettings({ animationSpeed: 'fast' });
    expect(headersOf(calls[0]!)['X-Luck-Client']).toBe('1');
    expect(headersOf(calls[0]!)['Content-Type']).toBeUndefined();
    expect(calls[1]!.init.method).toBe('PUT');
    expect(headersOf(calls[1]!)['X-Luck-Client']).toBe('1');
    expect(headersOf(calls[1]!)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ animationSpeed: 'fast' });
  });

  it('adds a fresh Idempotency-Key to create / rounds / control and reuses a supplied one', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: {} }]);
    let n = 0;
    const api = createApiClient({ fetch: fn, newKey: () => `key-${++n}` });
    await api.createSession({ player: { kind: 'manual' } });
    await api.placeManualRound('s1', [{ type: 'red', stake: 100 }]);
    await api.control('s1', 'start');
    await api.control('s1', 'stop', { idempotencyKey: 'retry-key' });
    await api.updateSettings({});
    expect(calls.map((c) => headersOf(c)['Idempotency-Key'])).toEqual(['key-1', 'key-2', 'key-3', 'retry-key', undefined]);
    expect(calls[1]!.url).toBe('/api/sessions/s1/rounds');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ bets: [{ type: 'red', stake: 100 }] });
    expect(calls[2]!.url).toBe('/api/sessions/s1/control');
  });

  it('uses crypto.randomUUID for keys by default', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: {} }]);
    await createApiClient({ fetch: fn }).control('s1', 'pause');
    expect(headersOf(calls[0]!)['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('parses ApiErrorBody into ApiError(code, message, status, details)', async () => {
    const { fn } = mockFetch([
      { status: 422, body: { error: { code: 'invalid_bet', message: 'Split 1/5 is not adjacent', details: ['bad pair'] } } },
    ]);
    const api = createApiClient({ fetch: fn });
    const err = await api.placeManualRound('s1', [{ type: 'split', numbers: [1, 5], stake: 100 }]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid_bet', message: 'Split 1/5 is not adjacent', status: 422, details: ['bad pair'] });
  });

  it('maps non-JSON errors and network failures without inventing server codes', async () => {
    const { fn } = mockFetch([{ status: 502, raw: '<html>Bad gateway</html>' }]);
    const e1 = await createApiClient({ fetch: fn }).listSessions().catch((e) => e);
    expect(e1).toMatchObject({ code: 'internal', status: 502 });

    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const e2 = await createApiClient({ fetch: failing }).listSessions().catch((e) => e);
    expect(e2).toBeInstanceOf(ApiError);
    expect(e2).toMatchObject({ code: 'network_error', status: 0 });
  });

  it('builds query strings, encodes ids and exposes export / events URLs', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { rounds: [] } }]);
    const api = createApiClient({ fetch: fn });
    await api.listRounds('a/b', { limit: 50, beforeSeq: 10 });
    expect(calls[0]!.url).toBe('/api/sessions/a%2Fb/rounds?limit=50&beforeSeq=10');
    expect(api.exportUrl('s1', 'csv')).toBe('/api/sessions/s1/export?format=csv');
    expect(api.eventsUrl('s1')).toBe('/api/events?sessionId=s1');
  });

  it('sends provider test / models requests with the non-secret player config', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { models: [] } }]);
    const api = createApiClient({ fetch: fn });
    await api.listModels('ollama', { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    await api.testProvider('anthropic');
    expect(calls[0]!.url).toBe('/api/providers/ollama/models');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ player: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' } });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({});
  });
});

describe('parseServerEvent', () => {
  it('accepts typed unnamed messages and bare named events, rejects junk', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'heartbeat', at: 'T' }))).toEqual({ type: 'heartbeat', at: 'T' });
    const round = { id: 'r', seq: 1 };
    expect(parseServerEvent(JSON.stringify({ type: 'round', round }))).toEqual({ type: 'round', round });
    expect(parseServerEvent(JSON.stringify(round), 'round')).toEqual({ type: 'round', round });
    expect(parseServerEvent('not json')).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'mystery' }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'round' }))).toBeNull();
  });
});
