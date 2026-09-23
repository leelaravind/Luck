/**
 * HTTP security tests (FIXTURE GameService — no real game, database or provider involved).
 * Covers: Host allow-list (DNS rebinding), Origin allow-list, Sec-Fetch-Site, X-Luck-Client,
 * security headers incl. CSP on every response, and that no Access-Control-* header is ever sent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppConfig } from '../types.js';
import { CONTENT_SECURITY_POLICY, buildPolicy, checkRequest, isApiPath } from './security.js';
import { FIXTURE_SESSION_ID, OK_HEADERS, OK_POST_HEADERS, createFakeService, testConfig } from './__tests__/fake-service.js';

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function makeApp(config: Partial<AppConfig> = {}) {
  const service = createFakeService();
  app = await buildApp({ config: testConfig(config), service });
  return { app, service };
}

function expectNoCors(headers: Record<string, unknown>) {
  const cors = Object.keys(headers).filter((h) => h.toLowerCase().startsWith('access-control-'));
  expect(cors).toEqual([]);
}

describe('CSP and security headers', () => {
  it('uses the exact documented CSP', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(EXPECTED_CSP);
  });

  it('are present on success, forbidden, not-found and error responses', async () => {
    const { app } = await makeApp();
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/health', headers: OK_HEADERS }),
      app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } }),
      app.inject({ method: 'GET', url: '/api/does-not-exist', headers: OK_HEADERS }),
      app.inject({ method: 'GET', url: '/api/sessions/unknown-id', headers: OK_HEADERS }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 403, 404, 404]);
    for (const r of responses) {
      expect(r.headers['content-security-policy']).toBe(EXPECTED_CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expectNoCors(r.headers);
    }
  });

  it('API responses are not cacheable', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: OK_HEADERS });
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('Host header allow-list (DNS rebinding)', () => {
  it.each(['127.0.0.1:3717', 'localhost:3717', '[::1]:3717', 'LOCALHOST:3717'])('accepts %s', async (host) => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, version: '0.0.0-test' });
  });

  it.each(['evil.example', 'evil.example:3717', '127.0.0.1:9999', '127.0.0.1', 'localhost', '192.168.1.20:3717', '0.0.0.0:3717'])(
    'rejects %s with 403 ApiErrorBody',
    async (host) => {
      const { app, service } = await makeApp();
      const r = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host } });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: 'forbidden' } });
      expect(service.calls).toEqual([]);
    },
  );

  it('rejects a rebinding Host on non-API paths too', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } });
    expect(r.statusCode).toBe(403);
  });

  it('accepts the Vite dev server host only when dev origins are configured', async () => {
    const dev = await makeApp({ isDev: true, devOrigins: ['http://127.0.0.1:5717', 'http://localhost:5717'] });
    expect((await dev.app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:5717' } })).statusCode).toBe(200);
    await dev.app.close();

    const prod = await makeApp({ isDev: false, devOrigins: [] });
    expect((await prod.app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:5717' } })).statusCode).toBe(403);
  });
});

describe('Origin header', () => {
  it('rejects a cross-origin Origin on GET and POST', async () => {
    const { app, service } = await makeApp();
    const get = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...OK_HEADERS, origin: 'https://evil.example' } });
    expect(get.statusCode).toBe(403);
    expect(get.json()).toMatchObject({ error: { code: 'forbidden' } });
    const post = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...OK_POST_HEADERS, origin: 'http://evil.example', 'idempotency-key': 'abcdefgh-1234' },
      payload: { player: { kind: 'manual' } },
    });
    expect(post.statusCode).toBe(403);
    expect(service.calls).toEqual([]);
  });

  it.each(['null', 'http://127.0.0.1:3718', 'https://127.0.0.1:3717', 'http://127.0.0.1:5717'])('rejects Origin %s in production', async (origin) => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { ...OK_HEADERS, origin } });
    expect(r.statusCode).toBe(403);
  });

  it('accepts our own origin, and the dev origin only in dev', async () => {
    const prod = await makeApp();
    expect((await prod.app.inject({ method: 'GET', url: '/api/health', headers: { ...OK_HEADERS, origin: 'http://127.0.0.1:3717' } })).statusCode).toBe(200);
    await prod.app.close();

    const dev = await makeApp({ isDev: true, devOrigins: ['http://127.0.0.1:5717', 'http://localhost:5717'] });
    const r = await dev.app.inject({ method: 'GET', url: '/api/health', headers: { ...OK_HEADERS, origin: 'http://localhost:5717' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('Sec-Fetch-Site', () => {
  it.each(['cross-site', 'same-site'])('rejects %s', async (site) => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...OK_HEADERS, 'sec-fetch-site': site } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it.each(['same-origin', 'none'])('accepts %s', async (site) => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/sessions', headers: { ...OK_HEADERS, 'sec-fetch-site': site } });
    expect(r.statusCode).toBe(200);
  });
});

describe('X-Luck-Client on state-changing requests', () => {
  it('rejects POST without the header before the service is called', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: `/api/sessions/${FIXTURE_SESSION_ID}/control`,
      headers: { host: '127.0.0.1:3717', 'content-type': 'application/json', 'idempotency-key': 'abcdefgh-1234' },
      payload: { action: 'start' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(service.calls).toEqual([]);
  });

  it.each(['0', 'true', '1, 1'])('rejects X-Luck-Client: %s', async (value) => {
    const { app } = await makeApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { ...OK_POST_HEADERS, 'x-luck-client': value },
      payload: { animationSpeed: 'fast' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('accepts the request with X-Luck-Client: 1', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: OK_POST_HEADERS, payload: { animationSpeed: 'fast' } });
    expect(r.statusCode).toBe(200);
    expect(service.calls).toEqual([['updateSettings', { animationSpeed: 'fast' }]]);
  });

  it('applies to non-GET requests on any path, including percent-encoded API paths', async () => {
    const { app, service } = await makeApp();
    const r = await app.inject({
      method: 'POST',
      url: '/%61pi/sessions',
      headers: { host: '127.0.0.1:3717', 'content-type': 'application/json', 'idempotency-key': 'abcdefgh-1234' },
      payload: { player: { kind: 'manual' } },
    });
    expect(r.statusCode).toBe(403);
    expect(service.calls).toEqual([]);
  });
});

describe('No CORS, ever', () => {
  it('a CORS preflight gets no Access-Control-* headers', async () => {
    const { app } = await makeApp();
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: { ...OK_HEADERS, origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-luck-client' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expectNoCors(r.headers);
  });

  it('strips Access-Control-* headers even if something tries to add them', async () => {
    const { app } = await makeApp();
    app.get('/api/test-cors-leak', async (_req, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'true');
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/api/test-cors-leak', headers: OK_HEADERS });
    expect(r.statusCode).toBe(200);
    expectNoCors(r.headers);
  });
});

describe('checkRequest / isApiPath (pure)', () => {
  const policy = buildPolicy({ port: 3717, devOrigins: [] });

  it('treats encoded and upper-case API paths as API paths', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/sessions?x=1')).toBe(true);
    expect(isApiPath('/%61pi/sessions')).toBe(true);
    expect(isApiPath('/API/sessions')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/assets/app.js')).toBe(false);
  });

  it('allows a cross-site top-level navigation to a static page (Host still checked)', () => {
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: '127.0.0.1:3717', 'sec-fetch-site': 'cross-site' } }, policy)).toEqual({ ok: true });
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: 'evil.example' } }, policy).ok).toBe(false);
  });

  it('refuses a missing Host header', () => {
    expect(checkRequest({ method: 'GET', url: '/api/health', headers: {} }, policy).ok).toBe(false);
  });

  it('adds the actually bound port when it differs from config', () => {
    const p = buildPolicy({ port: 3717, devOrigins: [] }, [45678]);
    expect(p.allowedHosts.has('127.0.0.1:45678')).toBe(true);
    expect(p.allowedOrigins.has('http://localhost:45678')).toBe(true);
  });
});
