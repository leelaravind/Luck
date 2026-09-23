/**
 * OWNER: A7. Shared HTTP plumbing for the fetch-based adapters (Ollama, OpenAI-compatible) and
 * the error/rate-limit helpers the Anthropic SDK adapter reuses.
 *
 * Guarantees:
 *  - One deadline covers the WHOLE exchange (connect, headers and body), combined with the
 *    caller's AbortSignal. Timeout → 'timeout' (retryable); caller abort → 'cancelled'.
 *  - Response bodies are capped (default 1 MB) so a misbehaving server cannot exhaust memory.
 *  - Never throws for network/provider problems: failures come back as a typed ProviderError.
 *  - No retries here; the session runner owns bounded retries.
 *  - Every error message passes through redact() (plus masking of the caller's known secrets).
 */
import type { ProviderError, ProviderErrorCode, RateLimitInfo } from '../../shared/contracts.js';
import { redact } from '../redact.js';

const MAX_RESPONSE_BYTES = 1_000_000;
/** Longest provider-supplied error text kept in a ProviderError message. */
const MAX_ERROR_DETAIL_CHARS = 300;
/** Retry-After values beyond this are treated as nonsense and ignored. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── errors & redaction ─────────────────────────────

/** Mask known secret values (e.g. the API key used for this call), then apply the global redactor. */
export function safeText(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.trim().length >= 4) out = out.split(s.trim()).join('[redacted]');
  }
  return redact(out);
}

export function providerError(
  code: ProviderErrorCode,
  message: string,
  opts: { retryable?: boolean; retryAfterMs?: number; httpStatus?: number; secrets?: readonly (string | undefined)[] } = {},
): ProviderError {
  const err: ProviderError = {
    code,
    message: safeText(message, opts.secrets),
    retryable: opts.retryable ?? false,
  };
  if (opts.retryAfterMs !== undefined) err.retryAfterMs = opts.retryAfterMs;
  if (opts.httpStatus !== undefined) err.httpStatus = opts.httpStatus;
  return err;
}

/** Pull a human message out of a provider error body ({error:{message}}, {error:"…"}, {message}, or text). */
function extractErrorDetail(bodyText: string | undefined | null): string {
  if (!bodyText) return '';
  let detail = bodyText.trim();
  try {
    const j = JSON.parse(bodyText) as unknown;
    if (j && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      const e = o.error;
      if (typeof e === 'string') detail = e;
      else if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') {
        detail = (e as Record<string, unknown>).message as string;
      } else if (typeof o.message === 'string') detail = o.message;
      else if (typeof o.detail === 'string') detail = o.detail;
    }
  } catch {
    /* not JSON: keep the text */
  }
  detail = detail.replace(/\s+/g, ' ');
  return detail.length > MAX_ERROR_DETAIL_CHARS ? `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : detail;
}

// ───────────────────────────── headers ─────────────────────────────

/** Minimal header accessor so both fetch Headers and plain records work. */
type HeaderSource = Headers | Record<string, string | string[] | undefined> | null | undefined;

function headerEntries(h: HeaderSource): [string, string][] {
  if (!h) return [];
  if (typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function') {
    const out: [string, string][] = [];
    (h as Headers).forEach((value, key) => out.push([key.toLowerCase(), value]));
    return out;
  }
  return Object.entries(h as Record<string, string | string[] | undefined>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]);
}

function getHeader(h: HeaderSource, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headerEntries(h)) if (k === lower) return v;
  return undefined;
}

/**
 * Retry delay from `retry-after-ms` (milliseconds) or `retry-after` (delta-seconds or HTTP-date).
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(h: HeaderSource, now: number = Date.now()): number | undefined {
  const ms = getHeader(h, 'retry-after-ms');
  if (ms !== undefined && ms.trim() !== '') {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), MAX_RETRY_AFTER_MS);
  }
  const ra = getHeader(h, 'retry-after');
  if (ra === undefined || ra.trim() === '') return undefined;
  const trimmed = ra.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Math.ceil(Number(trimmed) * 1000), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

/** "1s", "6m0s", "20ms", "1h2m3.5s" (OpenAI x-ratelimit-reset-*) → milliseconds. */
function parseGoDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
    consumed += m[0].length;
  }
  return consumed === s.length && consumed > 0 ? total : undefined;
}

/** Reset value → ISO timestamp. Accepts RFC 3339 dates, unix seconds, plain seconds-from-now or Go durations. */
function parseReset(value: string, now: number): string | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    // Large numbers are epoch seconds; small ones are "seconds until reset".
    const at = n > 1e9 ? n * 1000 : now + n * 1000;
    return new Date(at).toISOString();
  }
  const dur = parseGoDuration(v);
  if (dur !== undefined) return new Date(now + dur).toISOString();
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : new Date(date).toISOString();
}

type RateEntry = RateLimitInfo['entries'][number];

function applyField(entry: RateEntry, field: string, value: string, now: number): void {
  const num = Number(value);
  switch (field) {
    case 'limit':
      if (Number.isFinite(num)) entry.limit = num;
      break;
    case 'remaining':
      if (Number.isFinite(num)) entry.remaining = num;
      break;
    case 'reset': {
      const at = parseReset(value, now);
      if (at) entry.resetAt = at;
      break;
    }
    case 'utilization':
      if (Number.isFinite(num)) entry.utilization = num;
      break;
    case 'status':
      entry.status = value.trim();
      break;
  }
}

/**
 * Rate-limit headers → RateLimitInfo (source 'response-headers'), or null when none are present.
 *  - anthropic-ratelimit-<name>-<limit|remaining|reset|utilization|status>
 *      e.g. anthropic-ratelimit-requests-remaining, anthropic-ratelimit-input-tokens-reset,
 *           anthropic-ratelimit-unified-status
 *  - x-ratelimit-<limit|remaining|reset>-<name>   (OpenAI and most compatible servers)
 *      e.g. x-ratelimit-remaining-tokens, x-ratelimit-reset-requests: "6m0s"
 * These are API RATE limits reported by the provider, not spend, balance or plan quota.
 */
export function parseRateLimitHeaders(h: HeaderSource, now: number = Date.now()): RateLimitInfo | null {
  const entries = new Map<string, RateEntry>();
  const entryFor = (name: string): RateEntry => {
    let e = entries.get(name);
    if (!e) {
      e = { name };
      entries.set(name, e);
    }
    return e;
  };
  const FIELDS = ['limit', 'remaining', 'reset', 'utilization', 'status'];

  for (const [key, value] of headerEntries(h)) {
    if (key.startsWith('anthropic-ratelimit-')) {
      const rest = key.slice('anthropic-ratelimit-'.length);
      const idx = rest.lastIndexOf('-');
      const field = idx >= 0 ? rest.slice(idx + 1) : rest;
      const name = idx >= 0 ? rest.slice(0, idx) : 'default';
      if (FIELDS.includes(field)) applyField(entryFor(name), field, value, now);
      // Other anthropic-ratelimit-* headers (e.g. unified-representative-claim) are kept verbatim.
      else applyField(entryFor(rest), 'status', value, now);
    } else if (key.startsWith('x-ratelimit-')) {
      const rest = key.slice('x-ratelimit-'.length);
      const idx = rest.indexOf('-');
      const field = idx >= 0 ? rest.slice(0, idx) : rest;
      const name = idx >= 0 ? rest.slice(idx + 1) : 'default';
      if (FIELDS.includes(field)) applyField(entryFor(name), field, value, now);
    }
  }
  const list = [...entries.values()].filter((e) => Object.keys(e).length > 1);
  if (list.length === 0) return null;
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { source: 'response-headers', capturedAt: new Date(now).toISOString(), entries: list };
}

// ───────────────────────────── status classification ─────────────────────────────

/**
 * Map a non-2xx HTTP status to a ProviderError.
 *   401/403/402 → auth · 400/404/413/422 (and other 4xx) → bad_request · 408 → timeout (retryable)
 *   409 → server_error (retryable) · 429 → rate_limited (retryable, Retry-After honoured)
 *   5xx incl. 529 overloaded → server_error (retryable)
 */
export function classifyHttpStatus(
  status: number,
  headers: HeaderSource,
  bodyText: string | undefined | null,
  opts: { providerLabel: string; secrets?: readonly (string | undefined)[] },
): ProviderError {
  const detail = extractErrorDetail(bodyText);
  const suffix = detail ? `: ${detail}` : '';
  const p = opts.providerLabel;
  const base = { httpStatus: status, secrets: opts.secrets };

  if (status === 401 || status === 403) {
    return providerError('auth', `${p} rejected the credentials (HTTP ${status})${suffix}`, base);
  }
  if (status === 402) {
    return providerError('auth', `${p} reported a billing/payment problem (HTTP 402)${suffix}`, base);
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers);
    return providerError('rate_limited', `${p} rate limit reached (HTTP 429)${suffix}`, {
      ...base,
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status === 408) {
    return providerError('timeout', `${p} reported a request timeout (HTTP 408)${suffix}`, { ...base, retryable: true });
  }
  if (status === 409) {
    return providerError('server_error', `${p} reported a conflict (HTTP 409)${suffix}`, { ...base, retryable: true });
  }
  if (status === 404) {
    return providerError('bad_request', `${p} returned 404 Not Found (check the base URL and model name)${suffix}`, base);
  }
  if (status >= 500) {
    const what = status === 529 ? 'is overloaded' : 'had a server error';
    const retryAfterMs = parseRetryAfterMs(headers);
    return providerError('server_error', `${p} ${what} (HTTP ${status})${suffix}`, {
      ...base,
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status >= 400) {
    return providerError('bad_request', `${p} rejected the request (HTTP ${status})${suffix}`, base);
  }
  return providerError('unknown', `${p} returned unexpected HTTP ${status}${suffix}`, base);
}

/** Network-level failure (no HTTP response) → 'unavailable' (retryable) or 'unknown'. */
function classifyNetworkError(
  err: unknown,
  opts: { providerLabel: string; target: string; secrets?: readonly (string | undefined)[] },
): ProviderError {
  const codes: string[] = [];
  const collect = (e: unknown, depth: number): void => {
    if (!e || typeof e !== 'object' || depth > 4) return;
    const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === 'string') codes.push(o.code);
    if (Array.isArray(o.errors)) for (const x of o.errors) collect(x, depth + 1);
    collect(o.cause, depth + 1);
  };
  collect(err, 0);
  const message = err instanceof Error ? err.message : String(err);
  const causeMsg =
    err instanceof Error && err.cause instanceof Error && err.cause.message ? ` (${err.cause.message})` : '';

  const UNAVAILABLE = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_CLOSED',
  ];
  const hit = codes.find((c) => UNAVAILABLE.includes(c));
  if (hit) {
    const hint =
      hit === 'ECONNREFUSED'
        ? 'connection refused — is the server running?'
        : hit === 'ENOTFOUND' || hit === 'EAI_AGAIN'
          ? 'host name could not be resolved'
          : `network error ${hit}`;
    return providerError('unavailable', `${opts.providerLabel} at ${opts.target} is unreachable: ${hint}`, {
      retryable: true,
      secrets: opts.secrets,
    });
  }
  if (/redirect/i.test(message + causeMsg)) {
    return providerError(
      'bad_request',
      `${opts.providerLabel} at ${opts.target} answered with a redirect, which is not followed (check the base URL)`,
      { secrets: opts.secrets },
    );
  }
  if (err instanceof TypeError && /fetch failed/i.test(message)) {
    return providerError('unavailable', `${opts.providerLabel} at ${opts.target} is unreachable: ${message}${causeMsg}`, {
      retryable: true,
      secrets: opts.secrets,
    });
  }
  return providerError('unknown', `${opts.providerLabel} request failed: ${message}${causeMsg}`, { secrets: opts.secrets });
}

// ───────────────────────────── deadline + abort ─────────────────────────────

/**
 * Combine the caller's AbortSignal with a deadline. `outcome()` tells which one fired first,
 * so an abort can be reported as 'timeout' vs 'cancelled' regardless of the error type the
 * underlying library throws. Always call dispose().
 */
export function createDeadline(timeoutMs: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  let fired: 'timeout' | 'cancelled' | null = null;
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;

  const onCallerAbort = (): void => {
    if (!fired) fired = 'cancelled';
    controller.abort(callerSignal?.reason);
  };
  const timer = setTimeout(() => {
    if (!fired) fired = 'timeout';
    controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError'));
  }, ms);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  /** Rejects (never resolves) when either the deadline or the caller aborts — for Promise.race backstops. */
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new DOMException('aborted', 'AbortError'));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => undefined); // never an unhandled rejection

  return {
    signal: controller.signal,
    timeoutMs: ms,
    aborted,
    outcome: (): 'timeout' | 'cancelled' | null => fired,
    dispose: (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export function abortError(kind: 'timeout' | 'cancelled', providerLabel: string, timeoutMs: number): ProviderError {
  return kind === 'timeout'
    ? providerError('timeout', `${providerLabel} did not answer within ${timeoutMs} ms`, { retryable: true })
    : providerError('cancelled', `${providerLabel} request was cancelled`, { retryable: false });
}

// ───────────────────────────── JSON over HTTP ─────────────────────────────

interface HttpJsonRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Serialised as JSON when present. */
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Label used in error messages, e.g. "Ollama". */
  providerLabel: string;
  /** Values masked from any error text (API keys used for this call). */
  secrets?: readonly (string | undefined)[];
}

type HttpJsonResult =
  | { ok: true; status: number; headers: Headers; text: string; json: unknown; latencyMs: number }
  | { ok: false; error: ProviderError; status: number | null; headers: Headers | null; text: string | null; latencyMs: number };

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { tooLarge: true };
  }
  if (!res.body) return { text: '' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(buf) };
}

/** Human-readable target for messages: origin + path, never query strings or userinfo. */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'the configured endpoint';
  }
}

/**
 * Fetch JSON with a whole-exchange deadline, caller abort, size cap and typed errors.
 * Resolves (never rejects) with either the parsed body or a ProviderError.
 * Redirects are not followed (a redirect could carry credentials to another host).
 */
export async function httpJson(req: HttpJsonRequest): Promise<HttpJsonResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const deadline = createDeadline(req.timeoutMs, req.signal);
  const maxBytes = req.maxBytes ?? MAX_RESPONSE_BYTES;
  const target = describeTarget(req.url);
  const fail = (error: ProviderError, extra: { status?: number; headers?: Headers; text?: string } = {}): HttpJsonResult => ({
    ok: false,
    error,
    status: extra.status ?? null,
    headers: extra.headers ?? null,
    text: extra.text ?? null,
    latencyMs: elapsed(),
  });

  try {
    if (deadline.outcome()) return fail(abortError(deadline.outcome()!, req.providerLabel, deadline.timeoutMs));
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    if (req.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await Promise.race([
        fetch(req.url, {
          method: req.method ?? (req.body !== undefined ? 'POST' : 'GET'),
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: deadline.signal,
          redirect: 'manual',
        }),
        deadline.aborted,
      ]);
    } catch (err) {
      const kind = deadline.outcome();
      if (kind) return fail(abortError(kind, req.providerLabel, deadline.timeoutMs));
      return fail(classifyNetworkError(err, { providerLabel: req.providerLabel, target, secrets: req.secrets }));
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return fail(
        providerError(
          'bad_request',
          `${req.providerLabel} at ${target} answered with a redirect (HTTP ${res.status}), which is not followed — check the base URL`,
          { httpStatus: res.status, secrets: req.secrets },
        ),
        { status: res.status, headers: res.headers },
      );
    }

    let body: { text: string } | { tooLarge: true };
    try {
      body = await Promise.race([readCapped(res, maxBytes), deadline.aborted]);
    } catch (err) {
      const kind = deadline.outcome();
      if (kind) return fail(abortError(kind, req.providerLabel, deadline.timeoutMs), { status: res.status, headers: res.headers });
      return fail(classifyNetworkError(err, { providerLabel: req.providerLabel, target, secrets: req.secrets }), {
        status: res.status,
        headers: res.headers,
      });
    }
    if ('tooLarge' in body) {
      return fail(
        providerError('invalid_output', `${req.providerLabel} response exceeded the ${maxBytes}-byte limit`, {
          httpStatus: res.status,
        }),
        { status: res.status, headers: res.headers },
      );
    }

    if (!res.ok) {
      return fail(
        classifyHttpStatus(res.status, res.headers, body.text, { providerLabel: req.providerLabel, secrets: req.secrets }),
        { status: res.status, headers: res.headers, text: body.text },
      );
    }

    let json: unknown;
    try {
      json = body.text.trim() === '' ? undefined : JSON.parse(body.text);
    } catch {
      return fail(
        providerError('invalid_output', `${req.providerLabel} returned a response body that is not valid JSON`, {
          httpStatus: res.status,
        }),
        { status: res.status, headers: res.headers, text: body.text },
      );
    }
    return { ok: true, status: res.status, headers: res.headers, text: body.text, json, latencyMs: elapsed() };
  } finally {
    deadline.dispose();
  }
}

// ───────────────────────────── URLs ─────────────────────────────

/** Validate an endpoint base URL: http(s) only, no embedded credentials, no query/fragment. */
export function validateBaseUrl(raw: string | undefined): { ok: true; url: URL } | { ok: false; issue: string } {
  if (raw === undefined || raw.trim() === '') return { ok: false, issue: 'No base URL is set' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, issue: 'Base URL is not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, issue: `Base URL must use http or https (got ${u.protocol.replace(':', '')})` };
  }
  if (u.username || u.password) {
    return { ok: false, issue: 'Base URL must not contain credentials; put the API key in the server .env instead' };
  }
  if (u.search || u.hash) return { ok: false, issue: 'Base URL must not contain a query string or fragment' };
  return { ok: true, url: u };
}

/** Join a base URL (which may carry a path such as /v1) with an API path. */
export function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export const nowIso = (): string => new Date().toISOString();

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}
