/**
 * API route tests against a FIXTURE GameService (see __tests__/fake-service.ts): request
 * validation, Idempotency-Key, delegation to the service, error mapping, body limit, export.
 * No real game logic, database or provider is exercised here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GameError, HTTP_STATUS_FOR, type ApiErrorCode } from '../../shared/contracts.js';
import type { GameService } from '../types.js';
import { buildApp } from '../app.js';
import { FIXTURE_SESSION_ID, OK_HEADERS, OK_POST_HEADERS, createFakeService, testConfig, type FakeService } from './__tests__/fake-service.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function makeApp(overrides: Partial<GameService> = {}): Promise<{ app: FastifyInstance; service: FakeService }> {
  const service = createFakeService(overrides);
  app = await buildApp({ config: testConfig(), service });
  return { app, service };
}

const KEY = '3f2a8c1e-7d4b-4e9a-b1c2-0a9f8e7d6c5b';
const post = (url: string, payload: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url,
  headers: { ...OK_POST_HEADERS, 'idempotency-key': KEY, ...extra },
  payload: payload as Record<string, unknown>,
});

describe('Idempotency-Key', () => {
  const targets = [
    ['/api/sessions', { player: { kind: 'manual' } }],
    [`/api/sessions/${FIXTURE_SESSION_ID}/rounds`, { bets: [] }],
    [`/api/sessions/${FIXTURE_SESSION_ID}/control`, { action: 'start' }],
  ] as const;

  it.each(targets)('is required on POST %s', async (url, payload) => {
    const { app, service } = await makeApp();
    const r = await app.inject({ method: 'POST', url, headers: OK_POST_HEADERS, payload });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: 'validation_error', message: expect.stringMatching(/Idempotency-Key/) } });
    expect(service.calls).toEqual([]);
  });

  it.each(['short', 'x'.repeat(129), 'has space 12345', 'bad/chars!123'])('rejects malformed key %j', async (key) => {
    const { app, service } = await makeApp();
    const r = await app.inject(post('/api/sessions', { player: { kind: 'manual' } }, { 'idempotency-key': key }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
    expect(service.calls).toEqual([]);
  });

  it('passes a valid key through to the service', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/control`, { action: 'pause' }));
    expect(r.statusCode).toBe(200);
    expect(service.calls).toEqual([['control', FIXTURE_SESSION_ID, 'pause', KEY]]);
  });
});

describe('request validation (zod → 400 validation_error)', () => {
  it('rejects an unknown player kind', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject(post('/api/sessions', { player: { kind: 'casino-bot' } }));
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: 'validation_error', details: { issues: expect.any(Array) } } });
    expect(service.calls).toEqual([]);
  });

  it('rejects secrets smuggled into PlayerConfig', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject(post('/api/sessions', { player: { kind: 'anthropic', apiKey: 'sk-ant-should-never-be-here' } }));
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('sk-ant-should-never-be-here');
    expect(service.calls).toEqual([]);
  });

  it('rejects an unknown control action', async () => {
    const { app } = await makeApp();
    const r = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/control`, { action: 'resume-forever' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
  });

  it('requires bets to be an array (details left to the service)', async () => {
    const { app, service } = await makeApp();
    const bad = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/rounds`, { bets: 'red' }));
    expect(bad.statusCode).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it('rejects non-JSON bodies with 415', async () => {
    const { app } = await makeApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { ...OK_POST_HEADERS, 'content-type': 'text/plain' },
      payload: 'animationSpeed=fast',
    });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: OK_POST_HEADERS, payload: '{"animationSpeed":' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
  });

  it('treats an empty application/json body as no body (optional-body routes still work)', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject({ method: 'POST', url: '/api/providers/ollama/models', headers: OK_POST_HEADERS, payload: '' });
    expect(r.statusCode).toBe(200);
    expect(service.calls).toEqual([['listModels', 'ollama', undefined]]);
    // …but a route that needs a body still rejects it.
    const c = await app.inject({ ...post(`/api/sessions/${FIXTURE_SESSION_ID}/control`, {}), payload: '' });
    expect(c.statusCode).toBe(400);
  });

  it('rejects prototype-poisoning JSON', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: OK_POST_HEADERS, payload: '{"__proto__":{"x":1}}' });
    expect(r.statusCode).toBe(400);
  });

  it('rejects an invalid limit query', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: `/api/sessions/${FIXTURE_SESSION_ID}/rounds?limit=-3`, headers: OK_HEADERS });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a provider test whose player.kind does not match the URL', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject({ method: 'POST', url: '/api/providers/ollama/test', headers: OK_POST_HEADERS, payload: { player: { kind: 'openai' } } });
    expect(r.statusCode).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it('returns 404 for an unknown provider kind', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'POST', url: '/api/providers/skynet/test', headers: OK_POST_HEADERS, payload: {} });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });
});

describe('body limit', () => {
  it('rejects bodies over 64 KB with 413 ApiErrorBody', async () => {
    const { app, service } = await makeApp();
    const big = { bets: [{ type: 'red', stake: 10, pad: 'x'.repeat(70 * 1024) }] };
    const r = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/rounds`, big));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: { code: 'validation_error', message: expect.stringMatching(/too large/) } });
    expect(service.calls).toEqual([]);
  });

  it('accepts a body just under the limit', async () => {
    const { app } = await makeApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: OK_POST_HEADERS,
      payload: JSON.stringify({ pricing: { 'ollama:m': { inputPerMTokUsd: 0, outputPerMTokUsd: 0, source: 'user', asOf: '2026-01-01' } } }).padEnd(60 * 1024, ' '),
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('GameError mapping', () => {
  const cases: [ApiErrorCode, string][] = [
    ['not_found', 'Session nope not found'],
    ['insufficient_funds', 'Balance too low'],
    ['invalid_bet', 'Split 1/5 is not adjacent'],
    ['limit_exceeded', 'Too many bets'],
    ['round_in_progress', 'A round is still being settled'],
    ['decision_in_flight', 'Waiting for the model'],
    ['invalid_state', 'Session is stopped'],
    ['duplicate_request', 'Duplicate'],
    ['provider_unavailable', 'Ollama is not running'],
    ['budget_exhausted', 'Budget used up'],
  ];

  it.each(cases)('%s → HTTP_STATUS_FOR + ApiErrorBody', async (code, message) => {
    const { app } = await makeApp({
      placeManualRound: () => {
        throw new GameError(code, message, { hint: 'fixture' });
      },
    });
    const r = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/rounds`, { bets: [{ type: 'red', stake: 100 }] }));
    expect(r.statusCode).toBe(HTTP_STATUS_FOR[code]);
    expect(r.json()).toEqual({ error: { code, message, details: { hint: 'fixture' } } });
  });

  it('GameError from an async service method (control) is mapped too', async () => {
    const { app } = await makeApp({
      control: async () => {
        throw new GameError('decision_in_flight', 'A decision is already in flight');
      },
    });
    const r = await app.inject(post(`/api/sessions/${FIXTURE_SESSION_ID}/control`, { action: 'step' }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'decision_in_flight', message: 'A decision is already in flight' } });
  });

  it('redacts secrets that leak into a GameError message or details', async () => {
    const { app } = await makeApp({
      testProvider: async () => {
        throw new GameError('provider_unavailable', 'upstream said: invalid x-api-key sk-ant-api03-LEAKED1234567890', {
          raw: 'Authorization: Bearer abc.def.ghi',
        });
      },
    });
    const r = await app.inject({ method: 'POST', url: '/api/providers/anthropic/test', headers: OK_POST_HEADERS, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('LEAKED1234567890');
    expect(r.body).not.toContain('abc.def.ghi');
    expect(r.body).toContain('[redacted]');
  });

  it('unknown errors → 500 internal with a generic message (no details leaked)', async () => {
    const { app } = await makeApp({
      listSessions: () => {
        throw new Error('database file corrupted at C:\\secret\\path sk-proj-ABCDEFGHIJKLMNOP');
      },
    });
    const r = await app.inject({ method: 'GET', url: '/api/sessions', headers: OK_HEADERS });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'internal', message: 'Internal server error.' } });
    expect(r.body).not.toContain('corrupted');
  });

  it('unknown API routes → JSON 404 not_found', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/nothing-here', headers: OK_HEADERS });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('delegation to the service', () => {
  it('GET routes return the documented shapes', async () => {
    const { app, service } = await makeApp();
    const id = FIXTURE_SESSION_ID;
    const get = (url: string) => app.inject({ method: 'GET', url, headers: OK_HEADERS });

    expect((await get('/api/providers')).json()).toEqual({ providers: [] });
    expect((await get('/api/sessions')).json().sessions[0].id).toBe(id);
    expect((await get(`/api/sessions/${id}`)).json().session.id).toBe(id);
    expect((await get(`/api/sessions/${id}/rounds?limit=5&beforeSeq=10`)).json()).toEqual({ rounds: [] });
    expect((await get(`/api/sessions/${id}/decisions?limit=7`)).json()).toEqual({ decisions: [] });
    expect((await get(`/api/sessions/${id}/usage`)).json()).toMatchObject({ records: [], summary: { requests: 0 } });
    expect((await get(`/api/sessions/${id}/logs`)).json()).toEqual({ logs: [] });
    expect((await get('/api/settings')).json()).toMatchObject({ animationSpeed: 'normal' });

    expect(service.calls).toContainEqual(['listRounds', id, { limit: 5, beforeSeq: 10 }]);
    expect(service.calls).toContainEqual(['listDecisions', id, 7]);
    expect(service.calls).toContainEqual(['listLogs', id, undefined]);
  });

  it('POST /api/sessions passes the validated request and key', async () => {
    const { app, service } = await makeApp();
    const body = { name: 'Try', player: { kind: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }, limits: { maxRounds: 10 } };
    const r = await app.inject(post('/api/sessions', body));
    expect(r.statusCode).toBe(200);
    expect(service.calls).toEqual([['createSession', body, KEY]]);
  });

  it('POST provider test/models pass the optional player config', async () => {
    const { app, service } = await makeApp();
    const player = { kind: 'ollama', model: 'qwen3' };
    const t = await app.inject({ method: 'POST', url: '/api/providers/ollama/test', headers: OK_POST_HEADERS, payload: { player } });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ ok: false, message: expect.stringContaining('fixture') });
    const m = await app.inject({ method: 'POST', url: '/api/providers/ollama/models', headers: { host: '127.0.0.1:3717', 'x-luck-client': '1' } });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ models: [] });
    expect(service.calls).toEqual([
      ['testProvider', 'ollama', player],
      ['listModels', 'ollama', undefined],
    ]);
  });

  it('export sends an attachment with the service content type', async () => {
    const { app } = await makeApp();
    const csv = await app.inject({ method: 'GET', url: `/api/sessions/${FIXTURE_SESSION_ID}/export?format=csv`, headers: OK_HEADERS });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="luck-${FIXTURE_SESSION_ID}.csv"`);
    expect(csv.body).toBe('seq,winningNumber\n');

    const json = await app.inject({ method: 'GET', url: `/api/sessions/${FIXTURE_SESSION_ID}/export`, headers: OK_HEADERS });
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['content-disposition']).toMatch(/^attachment; filename=".+\.json"$/);

    const bad = await app.inject({ method: 'GET', url: `/api/sessions/${FIXTURE_SESSION_ID}/export?format=xlsx`, headers: OK_HEADERS });
    expect(bad.statusCode).toBe(400);
  });

  it('export filenames are sanitised for Content-Disposition', async () => {
    const { app } = await makeApp({
      exportSession: () => ({ filename: 'evil"\r\nSet-Cookie: x=1.json', contentType: 'application/json', body: '{}' }),
    });
    const r = await app.inject({ method: 'GET', url: `/api/sessions/${FIXTURE_SESSION_ID}/export`, headers: OK_HEADERS });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="evil_Set-Cookie_x_1.json"');
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});
