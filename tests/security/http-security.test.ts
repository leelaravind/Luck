/**
 * SECURITY — HTTP boundary of the integrated backend (real app + service + SQLite; FIXTURE adapters).
 *
 * Proves (D4, D5): DNS-rebinding and cross-site requests are refused (Host, Origin, Sec-Fetch-Site),
 * state-changing requests need X-Luck-Client, no CORS headers are ever emitted (incl. preflight), CSP and
 * nosniff are set, the API key configured on the server never appears in any response / export / session
 * log / captured console output (even when a FIXTURE adapter deliberately echoes it in an error), and
 * internal errors do not leak stack traces or internal paths.
 */
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import type { GameService } from '../../src/server/types.js';
import type { SessionSnapshot } from '../../src/shared/contracts.js';
import {
  FAKE_SECRET,
  FixtureAdapter,
  INJECT_PORT,
  TMP_DIR,
  browserHeaders,
  control,
  createHarness,
  createSession,
  errorBody,
  expectOk,
  fixtureError,
  waitForStatus,
  type ApiResult,
  type Harness,
} from '../e2e/harness.js';

/** Raw request over a real socket so Host can be anything (fetch cannot forge Host). */
function rawRequest(port: number, opts: { method?: string; path: string; headers: Record<string, string> }) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
];

describe('SECURITY: HTTP boundary', () => {
  let h: Harness;
  let port: number;
  // Captured console / stdout / stderr during the suite (the app's own logger may bypass these; see docs/testing.md).
  const captured: string[] = [];
  const restore: (() => void)[] = [];

  // FIXTURE: a misbehaving adapter that puts the API key it was given into its error text and test message.
  const leaky = new FixtureAdapter({
    kind: 'anthropic',
    paid: true,
    respond: (call) => fixtureError('auth', `FIXTURE upstream said: invalid x-api-key ${call.cfg.apiKey ?? '(none)'}`, false),
    testConnection: (cfg) => ({
      ok: false,
      testedAt: new Date().toISOString(),
      latencyMs: 1,
      message: `FIXTURE: key ${cfg.apiKey ?? '(none)'} rejected`,
    }),
  });

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
      restore.push(() => ((stream as { write: unknown }).write = orig));
    }
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void captured.push(a.map(String).join(' ')));
      restore.push(() => spy.mockRestore());
    }
    h = await createHarness({ label: 'security', outcomes: [1, 2, 3, 4, 5], adapters: [leaky], listen: true, appLogger: true });
    port = h.config.port;
  });

  afterAll(async () => {
    await h?.close({ removeDb: true });
    for (const r of restore.splice(0)) r();
  });

  const expectForbidden = (res: ApiResult<unknown> | { status: number; body?: string }, what: string) => {
    expect(res.status, what).toBe(403);
    if ('json' in res) expect(errorBody(res).code).toBe('forbidden');
    else expect(JSON.parse(res.body ?? '{}').error?.code).toBe('forbidden');
  };

  it('baseline: a same-origin browser request is accepted', async () => {
    const res = await h.api<{ ok: boolean }>('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  describe('Host header (DNS rebinding)', () => {
    for (const host of ['evil.example', `evil.example:${48_717}`, '127.0.0.1.evil.example', '192.168.1.10', 'localhost.evil.example']) {
      it(`inject: Host ${host} → 403`, async () => {
        expectForbidden(await h.api('GET', '/api/health', { headers: { host } }), host);
        expectForbidden(await h.api('POST', '/api/sessions', { headers: { host }, body: { player: { kind: 'manual' } } }), `POST ${host}`);
      });
    }
    it('real socket: Host evil.example:<port> → 403, correct Host → 200', async () => {
      const base = { origin: `http://127.0.0.1:${port}`, 'x-luck-client': '1' };
      expectForbidden(await rawRequest(port, { path: '/api/health', headers: { ...base, host: `evil.example:${port}` } }), 'raw evil host');
      const ok = await rawRequest(port, { path: '/api/health', headers: { ...base, host: `127.0.0.1:${port}` } });
      expect(ok.status).toBe(200);
      for (const hd of CORS_HEADERS) expect(ok.headers[hd]).toBeUndefined();
    });
  });

  describe('Origin / Sec-Fetch-Site (cross-site requests)', () => {
    it('Origin http://evil.example → 403 on GET, POST and the SSE stream', async () => {
      const origin = 'http://evil.example';
      expectForbidden(await h.api('GET', '/api/sessions', { headers: { origin } }), 'GET');
      expectForbidden(await h.api('POST', '/api/sessions', { headers: { origin }, body: { player: { kind: 'manual' } } }), 'POST');
      expectForbidden(await h.api('GET', '/api/events', { headers: { origin, accept: 'text/event-stream' } }), 'SSE');
      const list = expectOk(await h.api<{ sessions: unknown[] }>('GET', '/api/sessions'), 'list');
      expect(list.sessions).toHaveLength(0); // the refused POST created nothing
    });
    it('Origin with a different port (another local app) → 403', async () => {
      expectForbidden(await h.api('POST', '/api/sessions', { headers: { origin: `http://127.0.0.1:${port + 1}` }, body: { player: { kind: 'manual' } } }), 'port');
    });
    it('Origin "null" (sandboxed iframe / file://) → 403', async () => {
      expectForbidden(await h.api('POST', '/api/sessions', { headers: { origin: 'null' }, body: { player: { kind: 'manual' } } }), 'null');
    });
    it('Sec-Fetch-Site: cross-site → 403 even with a correct Origin', async () => {
      expectForbidden(await h.api('GET', '/api/sessions', { headers: { 'sec-fetch-site': 'cross-site' } }), 'GET');
      expectForbidden(await h.api('POST', '/api/sessions', { headers: { 'sec-fetch-site': 'cross-site' }, body: { player: { kind: 'manual' } } }), 'POST');
    });
  });

  describe('custom header requirement', () => {
    it('POST without X-Luck-Client → 403 and no side effect', async () => {
      expectForbidden(await h.api('POST', '/api/sessions', { headers: { 'x-luck-client': undefined }, body: { player: { kind: 'manual' } } }), 'create');
      expect(expectOk(await h.api<{ sessions: unknown[] }>('GET', '/api/sessions'), 'list').sessions).toHaveLength(0);
    });
    it('POST /rounds and /control without X-Luck-Client → 403, balance unchanged', async () => {
      const { session } = await createSession(h, { player: { kind: 'manual' } });
      expectForbidden(
        await h.api('POST', `/api/sessions/${session.id}/rounds`, { headers: { 'x-luck-client': undefined }, body: { bets: [{ type: 'red', stake: 100 }] } }),
        'rounds',
      );
      expectForbidden(await h.api('POST', `/api/sessions/${session.id}/control`, { headers: { 'x-luck-client': undefined }, body: { action: 'start' } }), 'control');
      const snap = expectOk(await h.api<SessionSnapshot>('GET', `/api/sessions/${session.id}`), 'snap');
      expect(snap.session.balance).toBe(snap.session.startingBalance);
      expect(snap.session.roundsPlayed).toBe(0);
    });
    it('a simple cross-site form POST (text/plain, no custom header) → 403', async () => {
      const res = await h.api('POST', '/api/sessions', {
        headers: { 'x-luck-client': undefined, 'content-type': 'text/plain', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
        body: '{"player":{"kind":"manual"}}',
      });
      expect(res.status).toBe(403);
    });
  });

  it('OPTIONS preflight from a foreign origin gets no CORS grant', async () => {
    const res = await h.api('OPTIONS', '/api/sessions', {
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-luck-client,idempotency-key',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
      },
    });
    // Whatever the status (403 / 404 / 204), the browser must not receive a CORS grant.
    expect(res.status).not.toBe(500);
    for (const hd of CORS_HEADERS) expect(res.headers[hd], hd).toBeUndefined();
  });

  it('CSP and nosniff on API responses and on the served index.html', async () => {
    const apiRes = await h.api('GET', '/api/health');
    expect(String(apiRes.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(apiRes.headers['content-security-policy'] ?? '')).toMatch(/default-src/);
    // A top-level navigation: browsers send no Origin and cannot add X-Luck-Client here.
    const page = await h.api('GET', '/', {
      headers: {
        accept: 'text/html',
        origin: undefined,
        'x-luck-client': undefined,
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toMatch(/text\/html/);
    const csp = String(page.headers['content-security-policy'] ?? '');
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(String(page.headers['x-content-type-options'])).toBe('nosniff');
  });

  describe('the configured API key never leaves the server', () => {
    it('FIXTURE leaky adapter: provider list, connection test, AI session, logs and exports are secret-free', async () => {
      const providers = await h.api('GET', '/api/providers');
      expect(providers.status).toBe(200);
      const test = await h.api<{ ok: boolean; message: string }>('POST', '/api/providers/anthropic/test', { body: {} });
      expect(test.status).toBeLessThan(500);
      // Non-vacuous: the FIXTURE's message did reach the browser — with the key replaced.
      expect(test.json.ok).toBe(false);
      expect(test.json.message).toMatch(/FIXTURE: key .*rejected/);
      expect(test.json.message).toContain('[redacted]');
      await h.api('POST', '/api/providers/anthropic/models', { body: {} });
      await h.api('GET', '/api/settings');

      const { session } = await createSession(h, {
        player: { kind: 'anthropic', model: 'fixture-model-1', pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' } },
        limits: { maxRounds: 2, maxRetries: 0, maxConsecutiveFailures: 1, budgetMicros: 250_000 },
      });
      expectOk(await control(h, session.id, 'start'), 'start');
      const paused = await waitForStatus(h, session.id, ['paused', 'stopped', 'completed']);
      expect(paused.session.status).toBe('paused');
      expect(leaky.calls.length).toBeGreaterThanOrEqual(1);
      // The adapter WAS given the key server-side (that is legitimate) …
      expect(leaky.calls[0]!.cfg.apiKey).toBe(FAKE_SECRET);
      // … and its echoed error text is stored redacted, not dropped.
      const ds = expectOk(await h.api<{ decisions: { errorMessage: string | null }[] }>('GET', `/api/sessions/${session.id}/decisions`), 'decisions');
      expect(ds.decisions[0]!.errorMessage ?? '').toContain('[redacted]');
      // … but nothing derived from it may reach the browser.
      for (const url of [
        `/api/sessions/${session.id}`,
        `/api/sessions/${session.id}/decisions`,
        `/api/sessions/${session.id}/usage`,
        `/api/sessions/${session.id}/logs?limit=500`,
        `/api/sessions/${session.id}/export?format=json`,
        `/api/sessions/${session.id}/export?format=csv`,
        '/api/sessions',
        '/api/providers',
      ]) {
        const r = await h.api('GET', url);
        expect(r.status, url).toBe(200);
        expect(r.text.includes(FAKE_SECRET), url).toBe(false);
      }
    });

    it('FIXTURE leaky adapter + loadConfig(): a key with NO recognisable shape is still redacted (exact-value layer)', async () => {
      // Not "sk-…", not after "x-api-key"/"api_key=": only loadConfig()'s registration of the value can catch it.
      const PLAIN = 'plainvalue-test-SECRET456';
      const loaded = loadConfig({
        NODE_ENV: 'production',
        LUCK_HOST: '127.0.0.1',
        LUCK_PORT: String(INJECT_PORT),
        LUCK_DATA_DIR: path.join(TMP_DIR, 'loadconfig-data'),
        ANTHROPIC_API_KEY: PLAIN,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        LAYA_BASE_URL: 'http://127.0.0.1:9',
        CLAUDE_CLI_ENABLED: '0',
      });
      expect(loaded.host).toBe('127.0.0.1');
      expect(loaded.isDev).toBe(false);
      expect(loaded.devOrigins).toEqual([]);
      expect(loaded.providers.anthropic.apiKey).toBe(PLAIN);
      const plainLeaky = new FixtureAdapter({
        kind: 'anthropic',
        paid: true,
        respond: (call) => fixtureError('auth', `FIXTURE upstream: credential ${call.cfg.apiKey ?? '(none)'} refused`, false),
        testConnection: (cfg) => ({ ok: false, testedAt: new Date().toISOString(), latencyMs: 1, message: `FIXTURE: credential ${cfg.apiKey ?? '(none)'} refused` }),
      });
      const hl = await createHarness({
        label: 'security-loadconfig',
        adapters: [plainLeaky],
        configOverride: (base) => ({ ...loaded, port: base.port, dbPath: base.dbPath, dataDir: base.dataDir, webDistDir: base.webDistDir }),
      });
      try {
        const t = await hl.api<{ message: string }>('POST', '/api/providers/anthropic/test', { body: {} });
        expect(t.json.message).toMatch(/FIXTURE: credential .* refused/);
        expect(t.json.message).toContain('[redacted]');
        const { session } = await createSession(hl, {
          player: { kind: 'anthropic', model: 'fixture-model-1', pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' } },
          limits: { maxRounds: 1, maxRetries: 0, maxConsecutiveFailures: 1 },
        });
        expectOk(await control(hl, session.id, 'start'), 'start');
        await waitForStatus(hl, session.id, ['paused', 'stopped', 'completed']);
        expect(plainLeaky.calls[0]!.cfg.apiKey).toBe(PLAIN); // the adapter did receive it server-side
        for (const url of [`/api/sessions/${session.id}`, `/api/sessions/${session.id}/decisions`, `/api/sessions/${session.id}/logs`, `/api/sessions/${session.id}/export?format=json`, `/api/sessions/${session.id}/export?format=csv`, '/api/providers']) {
          await hl.api('GET', url);
        }
        expect(hl.transcript.length).toBeGreaterThan(5);
        for (const r of hl.transcript) expect(r.body.includes(PLAIN), `${r.method} ${r.url}`).toBe(false);
      } finally {
        await hl.close({ removeDb: true });
      }
    });

    it('no response in this suite (bodies AND headers) and no captured console output contains the key', () => {
      expect(h.transcript.length).toBeGreaterThan(20);
      for (const r of h.transcript) {
        expect(r.body.includes(FAKE_SECRET), `${r.method} ${r.url} body`).toBe(false);
        expect(JSON.stringify(r.headers).includes(FAKE_SECRET), `${r.method} ${r.url} headers`).toBe(false);
        for (const hd of CORS_HEADERS) expect(r.headers[hd], `${r.method} ${r.url} ${hd}`).toBeUndefined();
      }
      expect(captured.join('\n').includes(FAKE_SECRET)).toBe(false);
    });
  });

  describe('error bodies', () => {
    it('internal errors → 500 ApiErrorBody without stack traces, paths or secrets', async () => {
      const marker = `boom-internal-marker at H:\\secret\\db\\sqlite.ts:42:13 key=${FAKE_SECRET}`;
      const hx = await createHarness({
        label: 'security-500',
        appLogger: true,
        wrapService: (svc) =>
          new Proxy(svc, {
            get(target, prop, recv) {
              if (prop === 'listSessions' || prop === 'getSnapshot') {
                return () => {
                  const e = new Error(marker);
                  e.stack = `Error: ${marker}\n    at Object.listSessions (H:\\LUCKY\\Luck\\src\\server\\session\\service.ts:10:5)`;
                  throw e;
                };
              }
              const v = Reflect.get(target, prop, recv);
              return typeof v === 'function' ? v.bind(target) : v;
            },
          }) as GameService,
      });
      try {
        for (const url of ['/api/sessions', '/api/sessions/some-id']) {
          const res = await hx.api('GET', url);
          expect(res.status, url).toBe(500);
          const err = errorBody(res);
          expect(err.code).toBe('internal');
          expect(res.text).not.toMatch(/\bat .+\.(ts|js):\d+/);
          expect(res.text).not.toContain('service.ts');
          expect(res.text).not.toContain('sqlite.ts');
          expect(res.text).not.toContain(FAKE_SECRET);
          expect(res.text).not.toContain('boom-internal-marker');
          expect(res.text).not.toMatch(/"stack"/);
        }
        // The server-side log does describe the failure (so the capture is not vacuous) — without the secret.
        const logged = captured.join(' | ');
        expect(logged).toContain('boom-internal-marker');
        expect(logged.includes(FAKE_SECRET)).toBe(false);
      } finally {
        await hx.close({ removeDb: true });
      }
    });

    it('malformed JSON → 400 ApiErrorBody without parser internals', async () => {
      const res = await h.api('POST', '/api/sessions', { body: '{"player": {"kind": "manual"' });
      expect(res.status).toBe(400);
      expect(errorBody(res).code).toBe('validation_error');
      expect(res.text).not.toMatch(/\bat .+\.(ts|js):\d+/);
      expect(res.text).not.toContain('node_modules');
    });

    it('POST /api/sessions without an Idempotency-Key → 400 validation_error', async () => {
      const headers = browserHeaders(port, 'POST');
      expect(headers['idempotency-key']).toBeTruthy();
      const res = await h.api('POST', '/api/sessions', { headers: { 'idempotency-key': undefined }, body: { player: { kind: 'manual' } } });
      expect(res.status).toBe(400);
      expect(errorBody(res).code).toBe('validation_error');
    });

    it('unknown API route → 404 ApiErrorBody (not the SPA fallback)', async () => {
      const res = await h.api('GET', '/api/definitely-not-a-route');
      expect(res.status).toBe(404);
      expect(errorBody(res).code).toBe('not_found');
    });
  });
});
