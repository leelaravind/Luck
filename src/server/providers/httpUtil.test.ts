import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  httpJson,
  isLoopbackHost,
  joinUrl,
  parseRateLimitHeaders,
  parseRetryAfterMs,
  validateBaseUrl,
} from './httpUtil.js';
import { closedPortUrl, startMockServer, type MockServer } from './__tests__/mockHttp.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

describe('parseRetryAfterMs (header parsing, no network)', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '7' }, NOW)).toBe(7000);
    expect(parseRetryAfterMs({ 'retry-after': '1.5' }, NOW)).toBe(1500);
  });
  it('reads an HTTP-date relative to now', () => {
    expect(parseRetryAfterMs({ 'retry-after': 'Wed, 23 Sep 2026 12:00:30 GMT' }, NOW)).toBe(30_000);
    expect(parseRetryAfterMs({ 'retry-after': 'Wed, 23 Sep 2026 11:00:00 GMT' }, NOW)).toBe(0);
  });
  it('prefers retry-after-ms', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '250', 'retry-after': '9' }, NOW)).toBe(250);
  });
  it('returns undefined for missing or junk values', () => {
    expect(parseRetryAfterMs({}, NOW)).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': 'soon' }, NOW)).toBeUndefined();
  });
  it('works with fetch Headers', () => {
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '3' }), NOW)).toBe(3000);
  });
});

describe('parseRateLimitHeaders (header parsing, no network)', () => {
  it('parses anthropic-ratelimit-* headers', () => {
    const info = parseRateLimitHeaders(
      {
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': '2026-09-23T12:00:05Z',
        'anthropic-ratelimit-input-tokens-limit': '30000',
        'anthropic-ratelimit-input-tokens-remaining': '29000',
        'anthropic-ratelimit-unified-status': 'allowed',
        'content-type': 'application/json',
      },
      NOW,
    );
    expect(info?.source).toBe('response-headers');
    expect(info?.capturedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(info?.entries).toEqual([
      { name: 'input-tokens', limit: 30000, remaining: 29000 },
      { name: 'requests', limit: 50, remaining: 49, resetAt: '2026-09-23T12:00:05.000Z' },
      { name: 'unified', status: 'allowed' },
    ]);
  });

  it('parses x-ratelimit-* headers with Go-style durations', () => {
    const info = parseRateLimitHeaders(
      {
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '120ms',
        'x-ratelimit-limit-tokens': '30000',
        'x-ratelimit-remaining-tokens': '29500',
        'x-ratelimit-reset-tokens': '1m30s',
      },
      NOW,
    );
    expect(info?.entries).toEqual([
      { name: 'requests', limit: 500, remaining: 499, resetAt: '2026-09-23T12:00:00.120Z' },
      { name: 'tokens', limit: 30000, remaining: 29500, resetAt: '2026-09-23T12:01:30.000Z' },
    ]);
  });

  it('returns null when no rate-limit headers are present', () => {
    expect(parseRateLimitHeaders({ 'content-type': 'application/json' }, NOW)).toBeNull();
    expect(parseRateLimitHeaders(null, NOW)).toBeNull();
  });
});

describe('classifyHttpStatus (no network)', () => {
  const cases: [number, string, boolean][] = [
    [400, 'bad_request', false],
    [401, 'auth', false],
    [402, 'auth', false],
    [403, 'auth', false],
    [404, 'bad_request', false],
    [408, 'timeout', true],
    [409, 'server_error', true],
    [413, 'bad_request', false],
    [422, 'bad_request', false],
    [429, 'rate_limited', true],
    [500, 'server_error', true],
    [502, 'server_error', true],
    [503, 'server_error', true],
    [504, 'server_error', true],
    [529, 'server_error', true],
  ];
  it.each(cases)('HTTP %i → %s (retryable %s)', (status, code, retryable) => {
    const e = classifyHttpStatus(status, { 'retry-after': '2' }, '{"error":{"message":"boom"}}', { providerLabel: 'P' });
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.httpStatus).toBe(status);
    expect(e.message).toContain('boom');
    if (status === 429) expect(e.retryAfterMs).toBe(2000);
  });

  it('redacts secrets echoed in provider error bodies', () => {
    const e = classifyHttpStatus(401, null, '{"error":{"message":"bad key sk-ant-api03-abcdefghijklmnop"}}', {
      providerLabel: 'P',
      secrets: ['my-custom-secret-value'],
    });
    expect(e.message).not.toContain('sk-ant-api03-abcdefghijklmnop');
    const e2 = classifyHttpStatus(401, null, 'key my-custom-secret-value rejected', {
      providerLabel: 'P',
      secrets: ['my-custom-secret-value'],
    });
    expect(e2.message).not.toContain('my-custom-secret-value');
  });
});

describe('URL helpers', () => {
  it('validateBaseUrl accepts http(s) and rejects others', () => {
    expect(validateBaseUrl('http://127.0.0.1:11434').ok).toBe(true);
    expect(validateBaseUrl('https://api.openai.com/v1').ok).toBe(true);
    expect(validateBaseUrl(undefined).ok).toBe(false);
    expect(validateBaseUrl('ftp://x').ok).toBe(false);
    expect(validateBaseUrl('not a url').ok).toBe(false);
    expect(validateBaseUrl('https://user:pass@host').ok).toBe(false);
    expect(validateBaseUrl('https://host/v1?key=abc').ok).toBe(false);
  });
  it('joinUrl keeps base paths', () => {
    expect(joinUrl('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUrl('http://localhost:11434', 'api/tags')).toBe('http://localhost:11434/api/tags');
  });
  it('isLoopbackHost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('api.openai.com')).toBe(false);
  });
});

describe('httpJson against a local mock server (FIXTURE — no real provider)', () => {
  let server: MockServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('returns parsed JSON and latency on 2xx', async () => {
    server = await startMockServer(() => ({ body: { hello: 'world' } }));
    const r = await httpJson({ url: `${server.baseUrl}/x`, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.json).toEqual({ hello: 'world' });
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('sends a JSON body with POST', async () => {
    server = await startMockServer(() => ({ body: {} }));
    await httpJson({ url: `${server.baseUrl}/p`, body: { a: 1 }, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(server.requests[0]!.method).toBe('POST');
    expect(server.requests[0]!.json).toEqual({ a: 1 });
    expect(server.requests[0]!.headers['content-type']).toBe('application/json');
  });

  it('times out when the server is slower than timeoutMs → timeout (retryable)', async () => {
    server = await startMockServer(() => ({ delayMs: 3000, body: {} }));
    const t0 = Date.now();
    const r = await httpJson({ url: `${server.baseUrl}/slow`, timeoutMs: 200, providerLabel: 'Mock' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('the deadline also covers a stalled response body', async () => {
    server = await startMockServer(() => ({ stallBodyMs: 3000, body: { late: true } }));
    const r = await httpJson({ url: `${server.baseUrl}/stall`, timeoutMs: 300, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('timeout');
  });

  it('caller abort → cancelled (not retryable)', async () => {
    server = await startMockServer(() => ({ delayMs: 3000, body: {} }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await httpJson({ url: `${server.baseUrl}/slow`, timeoutMs: 5000, signal: ac.signal, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('an already-aborted signal → cancelled without a request', async () => {
    server = await startMockServer(() => ({ body: {} }));
    const ac = new AbortController();
    ac.abort();
    const r = await httpJson({ url: `${server.baseUrl}/x`, timeoutMs: 5000, signal: ac.signal, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('cancelled');
    expect(server.requests).toHaveLength(0);
  });

  it('closed port → unavailable (retryable)', async () => {
    const url = await closedPortUrl();
    const r = await httpJson({ url: `${url}/x`, timeoutMs: 3000, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: 'unavailable', retryable: true });
      expect(r.error.message).toMatch(/refused/);
    }
  });

  it('caps the response size', async () => {
    server = await startMockServer(() => ({ body: { big: 'x'.repeat(5000) } }));
    const r = await httpJson({ url: `${server.baseUrl}/big`, timeoutMs: 2000, maxBytes: 1000, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_output');
  });

  it('does not follow redirects', async () => {
    server = await startMockServer((req) =>
      req.url === '/moved' ? { status: 302, headers: { location: '/elsewhere' } } : { body: { reached: true } },
    );
    const r = await httpJson({ url: `${server.baseUrl}/moved`, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('bad_request');
    expect(server.requests.map((q) => q.url)).toEqual(['/moved']);
  });

  it('non-JSON 2xx body → invalid_output', async () => {
    server = await startMockServer(() => ({ body: '<html>hi</html>' }));
    const r = await httpJson({ url: `${server.baseUrl}/x`, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_output');
  });

  it('429 with Retry-After seconds and with an HTTP-date', async () => {
    server = await startMockServer((req) =>
      req.url === '/secs'
        ? { status: 429, headers: { 'retry-after': '4' }, body: { error: { message: 'slow down' } } }
        : { status: 429, headers: { 'retry-after': new Date(Date.now() + 10_000).toUTCString() }, body: {} },
    );
    const a = await httpJson({ url: `${server.baseUrl}/secs`, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(!a.ok && a.error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 4000, httpStatus: 429 });
    const b = await httpJson({ url: `${server.baseUrl}/date`, timeoutMs: 2000, providerLabel: 'Mock' });
    expect(!b.ok && b.error.code).toBe('rate_limited');
    if (!b.ok) {
      expect(b.error.retryAfterMs).toBeGreaterThan(7000);
      expect(b.error.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('masks the API key if a server echoes it back', async () => {
    const key = 'test-key-1234567890-secret';
    server = await startMockServer(() => ({ status: 401, body: { error: { message: `invalid key ${key}` } } }));
    const r = await httpJson({ url: `${server.baseUrl}/x`, timeoutMs: 2000, providerLabel: 'Mock', secrets: [key] });
    expect(!r.ok && r.error.code).toBe('auth');
    if (!r.ok) expect(r.error.message).not.toContain(key);
  });
});
