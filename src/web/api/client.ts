/**
 * Typed fetch wrapper for every route in the "HTTP API" block of src/shared/contracts.ts.
 *
 * - Every request carries `X-Luck-Client: 1` (the server rejects state-changing requests without it,
 *   and the custom header forces a CORS preflight so cross-origin pages cannot call the API).
 * - Requests with a body send `Content-Type: application/json`.
 * - POST /api/sessions, /rounds and /control carry an `Idempotency-Key` (crypto.randomUUID()).
 *   Callers may pass their own key to retry the same logical action safely.
 * - Non-2xx responses are parsed as ApiErrorBody and thrown as ApiError.
 *
 * The browser never computes authoritative money values; this module only moves JSON.
 */
import type {
  AiProviderKind,
  ApiErrorBody,
  ApiErrorCode,
  AppSettings,
  AppSettingsPatch,
  BetInput,
  ConnectionTestResult,
  ControlAction,
  CreateSessionRequest,
  DecisionRecord,
  LogEntry,
  ManualRoundResponse,
  PlayerConfig,
  ProviderStatus,
  RoundRecord,
  SessionInfo,
  SessionSnapshot,
  UsageRecord,
  UsageSummary,
} from '../../shared/contracts';

/** Client-side failure codes that never come from the server (no response / unreadable response). */
export type ClientErrorCode = 'network_error' | 'bad_response';

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode | ClientErrorCode,
    message: string,
    /** HTTP status; 0 when the request never reached the server. */
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface UsageResponse {
  records: UsageRecord[];
  summary: UsageSummary;
}

export type ExportFormat = 'json' | 'csv';

export interface ApiClientOptions {
  /** Prefix for every route; '' = same origin (Vite proxies /api in development). */
  readonly baseUrl?: string;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Injected for tests. Defaults to crypto.randomUUID(). */
  readonly newKey?: () => string;
}

export interface MutationOptions {
  /** Reuse a key to retry the same logical request without repeating its effect. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** crypto.randomUUID() with a getRandomValues fallback for older engines. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  if (!v || typeof v !== 'object') return false;
  const e = (v as { error?: unknown }).error;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export function createApiClient(opts: ApiClientOptions = {}) {
  const base = opts.baseUrl ?? '';
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const newKey = opts.newKey ?? newIdempotencyKey;

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    extra: { idempotent?: boolean; key?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'X-Luck-Client': '1', Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extra.idempotent) headers['Idempotency-Key'] = extra.key ?? newKey();

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: extra.signal,
        credentials: 'same-origin',
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('network_error', 'Could not reach the Luck server. Is it running?', 0, String(err));
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      if (isApiErrorBody(parsed)) {
        throw new ApiError(parsed.error.code, parsed.error.message, res.status, parsed.error.details);
      }
      throw new ApiError(
        res.status >= 500 ? 'internal' : 'bad_response',
        `Request failed (HTTP ${res.status}).`,
        res.status,
      );
    }
    if (parsed === undefined) {
      throw new ApiError('bad_response', 'The server returned an empty or non-JSON response.', res.status);
    }
    return parsed as T;
  }

  return {
    health: (signal?: AbortSignal) => request<HealthResponse>('GET', '/api/health', undefined, { signal }),

    listProviders: (signal?: AbortSignal) =>
      request<{ providers: ProviderStatus[] }>('GET', '/api/providers', undefined, { signal }),

    testProvider: (kind: AiProviderKind, player?: PlayerConfig, signal?: AbortSignal) =>
      request<ConnectionTestResult>('POST', `/api/providers/${enc(kind)}/test`, player ? { player } : {}, { signal }),

    listModels: (kind: AiProviderKind, player?: PlayerConfig, signal?: AbortSignal) =>
      request<{ models: string[] }>('POST', `/api/providers/${enc(kind)}/models`, player ? { player } : {}, {
        signal,
      }),

    getSettings: (signal?: AbortSignal) => request<AppSettings>('GET', '/api/settings', undefined, { signal }),

    /**
     * PUT /api/settings. `pricing` entries are merged key by key; deletions go in `pricingRemove`.
     * `builtInPricingKeys` is read-only (filled by the server), so it is never sent.
     */
    updateSettings: (patch: AppSettingsPatch, signal?: AbortSignal) => {
      const { builtInPricingKeys: _readOnly, ...body } = patch;
      return request<AppSettings>('PUT', '/api/settings', body, { signal });
    },

    listSessions: (signal?: AbortSignal) =>
      request<{ sessions: SessionInfo[] }>('GET', '/api/sessions', undefined, { signal }),

    createSession: (req: CreateSessionRequest, o: MutationOptions = {}) =>
      request<SessionSnapshot>('POST', '/api/sessions', req, {
        idempotent: true,
        key: o.idempotencyKey,
        signal: o.signal,
      }),

    getSession: (id: string, signal?: AbortSignal) =>
      request<SessionSnapshot>('GET', `/api/sessions/${enc(id)}`, undefined, { signal }),

    placeManualRound: (id: string, bets: BetInput[], o: MutationOptions = {}) =>
      request<ManualRoundResponse>('POST', `/api/sessions/${enc(id)}/rounds`, { bets }, {
        idempotent: true,
        key: o.idempotencyKey,
        signal: o.signal,
      }),

    control: (id: string, action: ControlAction, o: MutationOptions = {}) =>
      request<SessionSnapshot>('POST', `/api/sessions/${enc(id)}/control`, { action }, {
        idempotent: true,
        key: o.idempotencyKey,
        signal: o.signal,
      }),

    listRounds: (id: string, p: { limit?: number; beforeSeq?: number } = {}, signal?: AbortSignal) =>
      request<{ rounds: RoundRecord[] }>(
        'GET',
        `/api/sessions/${enc(id)}/rounds${query({ limit: p.limit, beforeSeq: p.beforeSeq })}`,
        undefined,
        { signal },
      ),

    listDecisions: (id: string, limit?: number, signal?: AbortSignal) =>
      request<{ decisions: DecisionRecord[] }>(
        'GET',
        `/api/sessions/${enc(id)}/decisions${query({ limit })}`,
        undefined,
        { signal },
      ),

    getUsage: (id: string, signal?: AbortSignal) =>
      request<UsageResponse>('GET', `/api/sessions/${enc(id)}/usage`, undefined, { signal }),

    listLogs: (id: string, limit?: number, signal?: AbortSignal) =>
      request<{ logs: LogEntry[] }>('GET', `/api/sessions/${enc(id)}/logs${query({ limit })}`, undefined, {
        signal,
      }),

    /** Plain link target (GET download, no secrets). */
    exportUrl: (id: string, format: ExportFormat) => `${base}/api/sessions/${enc(id)}/export${query({ format })}`,

    /** EventSource URL for one session's ServerEvent stream. */
    eventsUrl: (sessionId: string) => `${base}/api/events${query({ sessionId })}`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
