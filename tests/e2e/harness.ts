/**
 * BLACK-BOX TEST HARNESS for the integrated backend (agent 10).
 *
 * Builds the real stack — config object → SQLite repository (file DB) → game service → Fastify app —
 * with only three things injected for determinism:
 *   - a FIXTURE outcome source (scripted winning numbers, call-counted),
 *   - FIXTURE provider adapters (scripted decisions, no network),
 *   - an optional fast sleep.
 *
 * Every HTTP request goes through `api()`, which sends the headers a same-origin browser page would send
 * (Host, Origin, Sec-Fetch-Site, X-Luck-Client, Idempotency-Key, Content-Type) and records the full
 * response (status, headers, body) in `transcript`, so suites can grep everything the server ever said.
 *
 * All integration seams to other agents' modules are in this file (search "SEAM"), so a signature change
 * only needs one edit here.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type {
  AiProviderKind,
  ApiErrorBody,
  BetInput,
  ConnectionTestResult,
  ProviderCapabilities,
  SessionSnapshot,
  UsageNumbers,
} from '../../src/shared/contracts.js';
import type {
  AppConfig,
  DecisionRequest,
  GameService,
  OutcomeSource,
  ProviderAdapter,
  ProviderCallResult,
  Repository,
  ResolvedProviderConfig,
} from '../../src/server/types.js';

// SEAM: modules owned by agents 1, 2, 3 and 9.
import { buildApp } from '../../src/server/app.js';
import { openRepository } from '../../src/server/db/sqlite.js';
import { createGameService } from '../../src/server/session/service.js';
import { createFixtureOutcomeSource } from '../../src/server/engine/fixtureOutcome.js';

// ───────────────────────────── paths & constants ─────────────────────────────

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Agent 10 scratch space (gitignored). Never /tmp. */
export const TMP_DIR = path.join(REPO_ROOT, 'tmp', '10');

/**
 * Fake secret placed in EVERY harness config (Anthropic, OpenAI and Laya keys).
 * It is allow-listed by scripts/secret-scan.mjs; suites assert it never appears in any response.
 */
export const FAKE_SECRET = 'sk-ant-test-SECRET123';

/** Port used in Host/Origin for inject()-only apps (never bound). */
export const INJECT_PORT = 48_717;

// ───────────────────────────── config ─────────────────────────────

function ensureWebDist(): string {
  // A minimal built-frontend directory so production static serving has something to serve.
  const dir = path.join(TMP_DIR, 'webdist');
  if (!existsSync(path.join(dir, 'index.html'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>Luck e2e</title></head><body><div id="root"></div></body></html>',
    );
  }
  return dir;
}

export function makeConfig(overrides: { port?: number; dbPath: string }): AppConfig {
  return {
    version: '0.0.0-e2e',
    host: '127.0.0.1',
    port: overrides.port ?? INJECT_PORT,
    devOrigins: [],
    isDev: false,
    dataDir: path.dirname(overrides.dbPath),
    dbPath: overrides.dbPath,
    webDistDir: ensureWebDist(),
    providers: {
      // Unreachable loopback ports: no real provider can ever be contacted from these suites.
      ollama: { baseUrl: 'http://127.0.0.1:9' },
      anthropic: { apiKey: FAKE_SECRET, baseUrl: 'http://127.0.0.1:9' },
      openai: { apiKey: FAKE_SECRET, baseUrl: 'http://127.0.0.1:9' },
      claudeCli: { enabled: false, useSubscriptionAuth: false },
      laya: { baseUrl: 'http://127.0.0.1:9', apiKey: FAKE_SECRET, checkpoint: 'english' },
    },
  };
}

export function tmpDbPath(label: string): string {
  const dir = path.join(TMP_DIR, 'db');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}-${randomUUID()}.db`);
}

export function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* Windows may briefly hold the handle; files live in gitignored tmp/10 anyway. */
    }
  }
}

/** Ask the OS for a free ephemeral port (listen on 0), then release it for the app to bind. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ───────────────────────────── FIXTURE outcome source ─────────────────────────────

export interface CountingOutcomeSource extends OutcomeSource {
  /** How many winning numbers have been drawn. */
  readonly calls: number;
  readonly drawn: number[];
}

/** Wraps agent 2's fixture source and counts draws (to prove outcomes are never redrawn). */
export function countingFixtureOutcomes(sequence: number[]): CountingOutcomeSource {
  const inner = createFixtureOutcomeSource(sequence); // SEAM
  const drawn: number[] = [];
  return {
    kind: 'fixture',
    get calls() {
      return drawn.length;
    },
    drawn,
    next() {
      const n = inner.next();
      drawn.push(n);
      return n;
    },
  };
}

// ───────────────────────────── FIXTURE provider adapters ─────────────────────────────

export const KNOWN_USAGE: UsageNumbers = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: true,
};

const UNKNOWN_USAGE: UsageNumbers = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
};

/** A successful FIXTURE provider response carrying raw model text. */
export function fixtureText(text: string, usage: UsageNumbers = KNOWN_USAGE): ProviderCallResult {
  return {
    ok: true,
    text,
    usage,
    latencyMs: 3,
    generationMs: null,
    providerCostUsd: null,
    modelReported: 'fixture-model-1',
    finishReason: 'stop',
    rateLimit: null,
    error: null,
  };
}

/** A successful FIXTURE response whose text is the JSON of `decision` (not validated here on purpose). */
export function fixtureDecision(decision: unknown, usage: UsageNumbers = KNOWN_USAGE): ProviderCallResult {
  return fixtureText(JSON.stringify(decision), usage);
}

/** A failed FIXTURE provider response (adapters never throw; they return typed errors). */
export function fixtureError(
  code: NonNullable<ProviderCallResult['error']>['code'],
  message: string,
  retryable = true,
): ProviderCallResult {
  return {
    ok: false,
    text: null,
    usage: UNKNOWN_USAGE,
    latencyMs: 2,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: null,
    rateLimit: null,
    error: { code, message, retryable },
  };
}

export interface FixtureCall {
  req: DecisionRequest;
  cfg: ResolvedProviderConfig;
  signal: AbortSignal;
  /** Outcome-source draw count at the moment the decision was requested. */
  drawsAtCall: number;
}

export interface FixtureAdapterOptions {
  kind: AiProviderKind;
  paid?: boolean;
  /** Produce the response for the n-th call (0-based). May be slow / never resolve until released. */
  respond: (call: FixtureCall, index: number) => ProviderCallResult | Promise<ProviderCallResult>;
  /** Used to snapshot the outcome draw count at call time. */
  outcomes?: CountingOutcomeSource;
  testConnection?: (cfg: ResolvedProviderConfig) => ConnectionTestResult | Promise<ConnectionTestResult>;
}

/**
 * FIXTURE ProviderAdapter: scripted responses, records every DecisionRequest it receives.
 * It is a test double — it never touches the network and is labelled as such in its capabilities.
 */
export class FixtureAdapter implements ProviderAdapter {
  readonly kind: AiProviderKind;
  readonly capabilities: ProviderCapabilities;
  readonly calls: FixtureCall[] = [];
  private readonly opts: FixtureAdapterOptions;

  constructor(opts: FixtureAdapterOptions) {
    this.opts = opts;
    this.kind = opts.kind;
    const paid = opts.paid ?? false;
    this.capabilities = {
      kind: opts.kind,
      label: `FIXTURE ${opts.kind} adapter (test double)`,
      local: !paid,
      paid,
      generatesText: true,
      reportsTokenUsage: 'full',
      reportsCost: false,
      listsModels: true,
      structuredOutput: false,
      quotaInfo: 'none',
      requiresApiKey: paid,
      notes: ['FIXTURE: scripted test double, never contacts a provider'],
    };
  }

  check(_cfg: ResolvedProviderConfig) {
    return { configured: true, enabled: true, issues: [] as string[] };
  }

  async testConnection(cfg: ResolvedProviderConfig, _signal: AbortSignal): Promise<ConnectionTestResult> {
    if (this.opts.testConnection) return this.opts.testConnection(cfg);
    return { ok: true, testedAt: new Date().toISOString(), latencyMs: 1, message: 'FIXTURE adapter: no network used' };
  }

  async listModels(_cfg: ResolvedProviderConfig, _signal: AbortSignal): Promise<string[]> {
    return ['fixture-model-1'];
  }

  async decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult> {
    const call: FixtureCall = { req, cfg, signal, drawsAtCall: this.opts.outcomes?.calls ?? -1 };
    this.calls.push(call);
    // Yield to the event loop like a real network call would.
    await new Promise((r) => setImmediate(r));
    return this.opts.respond(call, this.calls.length - 1);
  }
}

/** A promise gate a FIXTURE adapter can wait on (simulates a slow provider). */
export function gate<T = void>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => (release = r));
  return { promise, release };
}

// ───────────────────────────── the stack ─────────────────────────────

export interface RecordedResponse {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

export interface Harness {
  app: FastifyInstance;
  service: GameService;
  repo: Repository;
  config: AppConfig;
  outcomes: CountingOutcomeSource;
  dbPath: string;
  transcript: RecordedResponse[];
  /** Browser-like request helper (see module doc). */
  api: ApiFn;
  /** Shut down service, app and DB. Keeps the DB file unless `removeDb` is true. */
  close(opts?: { removeDb?: boolean }): Promise<void>;
}

export interface ApiOptions {
  body?: unknown;
  /** Override / remove (undefined) default headers. */
  headers?: Record<string, string | undefined>;
  idempotencyKey?: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  json: T;
}

export type ApiFn = <T = unknown>(method: string, url: string, opts?: ApiOptions) => Promise<ApiResult<T>>;

/** The headers a same-origin page at http://127.0.0.1:<port> sends with fetch(). */
export function browserHeaders(port: number, method: string, idempotencyKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    accept: 'application/json',
    'x-luck-client': '1',
  };
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    h['idempotency-key'] = idempotencyKey ?? randomUUID();
    h['content-type'] = 'application/json';
  }
  return h;
}

export interface HarnessOptions {
  label: string;
  /** Reuse an existing DB file (restart tests). */
  dbPath?: string;
  outcomes?: number[] | CountingOutcomeSource;
  adapters?: FixtureAdapter[];
  presentationDelayMs?: number;
  /** Default: a fast sleep (≤ 5 ms per call, still yields to the event loop). Pass 'real' for setTimeout. */
  sleep?: 'fast' | 'real';
  /** Bind a real TCP port (for SSE / raw-socket tests). */
  listen?: boolean;
  /** Wrap the service before handing it to the HTTP layer (e.g. fault injection). */
  wrapService?: (svc: GameService) => GameService;
  /** Replace the generated config (e.g. with one produced by loadConfig()); keep port/dbPath from `base`. */
  configOverride?: (base: AppConfig) => AppConfig;
  /** Turn on buildApp's console logger (warn+error, redacted) so suites can inspect what it prints. */
  appLogger?: boolean;
}

/** Abortable sleep (resolves early on abort, like the service's default). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}
/** Retry back-off and presentation waits capped at 5 ms (still yields to the event loop). */
const fastSleep = (ms: number, signal?: AbortSignal) => abortableSleep(Math.min(Math.max(ms, 0), 5), signal);
const realSleep = (ms: number, signal?: AbortSignal) => abortableSleep(ms, signal);

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = opts.dbPath ?? tmpDbPath(opts.label);
  const port = opts.listen ? await freePort() : INJECT_PORT;
  const base = makeConfig({ port, dbPath });
  const config = opts.configOverride ? opts.configOverride(base) : base;
  const outcomes = Array.isArray(opts.outcomes)
    ? countingFixtureOutcomes(opts.outcomes)
    : (opts.outcomes ?? countingFixtureOutcomes([]));

  const repo = openRepository(dbPath); // SEAM
  const adapters = new Map<AiProviderKind, ProviderAdapter>();
  for (const a of opts.adapters ?? []) adapters.set(a.kind, a);

  // SEAM: agent 9's dependency object.
  const service = createGameService({
    config,
    repo,
    adapters,
    outcomeSource: outcomes,
    sleep: opts.sleep === 'real' ? realSleep : fastSleep,
    // The service asks for a delay per animation speed; e2e runs use one fixed value.
    presentationDelayMs: () => opts.presentationDelayMs ?? 0,
  });
  const exposed = opts.wrapService ? opts.wrapService(service) : service;
  const app = await buildApp({ config, service: exposed, sseHeartbeatMs: 1_000, logger: opts.appLogger ?? false }); // SEAM
  if (opts.listen) await app.listen({ host: '127.0.0.1', port });
  else await app.ready();

  const transcript: RecordedResponse[] = [];

  const api: ApiFn = async <T,>(method: string, url: string, o: ApiOptions = {}) => {
    const headers: Record<string, string> = browserHeaders(port, method, o.idempotencyKey);
    for (const [k, v] of Object.entries(o.headers ?? {})) {
      if (v === undefined) delete headers[k.toLowerCase()];
      else headers[k.toLowerCase()] = v;
    }
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers,
      payload: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    });
    const rec: RecordedResponse = {
      method,
      url,
      status: res.statusCode,
      headers: res.headers as RecordedResponse['headers'],
      body: res.body,
    };
    transcript.push(rec);
    let json: unknown = undefined;
    try {
      json = res.body.length ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, headers: rec.headers, text: res.body, json: json as T };
  };

  let closed = false;
  return {
    app,
    service,
    repo,
    config,
    outcomes,
    dbPath,
    transcript,
    api,
    async close(c = {}) {
      if (closed) return;
      closed = true;
      await service.shutdown().catch(() => undefined);
      await app.close().catch(() => undefined);
      try {
        repo.close();
      } catch {
        /* the app's onClose hook may already have closed it */
      }
      if (c.removeDb) removeDbFiles(dbPath);
    },
  };
}

// ───────────────────────────── assertions & polling ─────────────────────────────

/** Throw with the full response when a request unexpectedly failed (much better diagnostics). */
export function expectOk<T>(res: ApiResult<T>, what: string): T {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what}: expected 2xx, got ${res.status}: ${res.text.slice(0, 800)}`);
  }
  return res.json;
}

/** Check that a response is a well-formed ApiErrorBody and return it. */
export function errorBody(res: ApiResult<unknown>): ApiErrorBody['error'] {
  const b = res.json as ApiErrorBody | undefined;
  if (!b || typeof b !== 'object' || !b.error || typeof b.error.code !== 'string' || typeof b.error.message !== 'string') {
    throw new Error(`Not an ApiErrorBody (status ${res.status}): ${res.text.slice(0, 400)}`);
  }
  return b.error;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  what: string,
  timeoutMs = 10_000,
  intervalMs = 15,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v as T;
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what} (last: ${String(last)})`);
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET the snapshot through HTTP. */
export async function snapshot(h: Harness, sessionId: string): Promise<SessionSnapshot> {
  return expectOk(await h.api<SessionSnapshot>('GET', `/api/sessions/${sessionId}`), 'GET snapshot');
}

/** Wait until the session reaches one of the given statuses (polling over HTTP). */
export async function waitForStatus(
  h: Harness,
  sessionId: string,
  statuses: SessionSnapshot['session']['status'][],
  timeoutMs = 10_000,
): Promise<SessionSnapshot> {
  return waitFor(
    async () => {
      const s = await snapshot(h, sessionId);
      return statuses.includes(s.session.status) ? s : undefined;
    },
    `session ${sessionId} status in [${statuses.join(', ')}]`,
    timeoutMs,
  );
}

export async function createSession(
  h: Harness,
  body: { name?: string; player: Record<string, unknown>; limits?: Record<string, unknown> },
  idempotencyKey?: string,
): Promise<SessionSnapshot> {
  return expectOk(
    await h.api<SessionSnapshot>('POST', '/api/sessions', { body, idempotencyKey }),
    'POST /api/sessions',
  );
}

export async function control(h: Harness, sessionId: string, action: string, idempotencyKey?: string) {
  return h.api<SessionSnapshot>('POST', `/api/sessions/${sessionId}/control`, { body: { action }, idempotencyKey });
}

export function bet(type: BetInput['type'], stake: number, extra: Partial<BetInput> = {}): BetInput {
  return { type, stake, ...extra };
}

/** Sum of ledger entry amounts (signed subunits). */
export function ledgerSum(ledger: { amount: number }[]): number {
  return ledger.reduce((s, e) => s + e.amount, 0);
}

/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Normalise a CSV header ("Balance After", "balance_after") → "balanceafter". */
export const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * True when a CSV money cell represents `subunits`, whether the exporter wrote raw integer
 * subunits ("4550") or decimal credits ("45.50"). No floating point is used for the comparison.
 */
export function moneyCellEquals(cell: string, subunits: number): boolean {
  const t = cell.trim().replace(/^\+/, '').replace('−', '-');
  if (/^-?\d+$/.test(t)) return Number(t) === subunits;
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(t);
  if (m) return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3])) === subunits;
  return false;
}

/** Recursively collect every object key (dotted path) in a JSON value. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...keyPaths(v, p)];
    });
  }
  return [];
}
