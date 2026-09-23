/**
 * TEST FIXTURES for the session layer. Everything here is fake by design:
 *  - FakeAdapter never contacts a provider; its answers are scripted by each test
 *  - outcomes come from createFixtureOutcomeSource (deterministic, test-only)
 *  - the clock and sleeps are injected so tests run instantly
 * Nothing in this file is used by production code.
 */
import type {
  AiProviderKind,
  AppSettings,
  BetInput,
  PlayerDecision,
  ProviderCapabilities,
  ProviderErrorCode,
  ServerEvent,
  UsageNumbers,
} from '../../../shared/contracts.js';
import { createFixtureOutcomeSource } from '../../engine/fixtureOutcome.js';
import { openRepository } from '../../db/sqlite.js';
import type {
  AppConfig,
  DecisionRequest,
  OutcomeSource,
  ProviderAdapter,
  ProviderCallResult,
  Repository,
  ResolvedProviderConfig,
} from '../../types.js';
import { createGameService } from '../service.js';

export const FAKE_ANTHROPIC_KEY = 'sk-ant-FIXTURE-not-a-real-key-000000000000';

export function testConfig(overrides: Partial<AppConfig['providers']> = {}): AppConfig {
  return {
    version: 'test',
    host: '127.0.0.1',
    port: 0,
    devOrigins: [],
    isDev: true,
    dataDir: 'tmp/9',
    dbPath: ':memory:',
    webDistDir: 'dist/web',
    providers: {
      ollama: { baseUrl: 'http://127.0.0.1:11434' },
      anthropic: { apiKey: FAKE_ANTHROPIC_KEY, baseUrl: 'https://api.anthropic.com' },
      openai: {},
      claudeCli: { enabled: true, useSubscriptionAuth: true },
      laya: { baseUrl: 'http://127.0.0.1:8000', checkpoint: 'english' },
      ...overrides,
    },
  };
}

// ───────────────────────────── deferred ─────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll (macrotask by macrotask) until `pred` is true. */
export async function waitUntil(pred: () => boolean, what = 'condition', timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

// ───────────────────────────── provider results ─────────────────────────────

export const KNOWN_USAGE: UsageNumbers = {
  inputTokens: 1_000,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: null,
  known: true,
};

const NO_USAGE: UsageNumbers = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
};

export function okText(text: string, extra: Partial<ProviderCallResult> = {}): ProviderCallResult {
  return {
    ok: true,
    text,
    usage: { ...KNOWN_USAGE },
    latencyMs: 500,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: 'stop',
    rateLimit: null,
    error: null,
    ...extra,
  };
}

export function okDecision(decision: PlayerDecision, extra: Partial<ProviderCallResult> = {}): ProviderCallResult {
  return okText(JSON.stringify(decision), extra);
}

export function betDecision(bets: BetInput[], explanation = 'fixture decision'): ProviderCallResult {
  return okDecision({ action: 'bet', bets, explanation });
}

export function failure(code: ProviderErrorCode, retryable: boolean, extra: { retryAfterMs?: number; httpStatus?: number } = {}): ProviderCallResult {
  return {
    ok: false,
    text: null,
    usage: { ...NO_USAGE },
    latencyMs: 100,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: null,
    rateLimit: null,
    error: { code, message: `fixture ${code}`, retryable, ...extra },
  };
}

// ───────────────────────────── fake adapter ─────────────────────────────

export type Handler = (req: DecisionRequest, signal: AbortSignal, callNo: number) => Promise<ProviderCallResult> | ProviderCallResult;

export interface FakeAdapter extends ProviderAdapter {
  readonly calls: { req: DecisionRequest; cfg: ResolvedProviderConfig; signal: AbortSignal }[];
  inFlight: number;
  maxInFlight: number;
  /** Handlers used for the next calls, in order; `fallback` afterwards. */
  script: Handler[];
  fallback: Handler;
}

export function fakeAdapter(opts: {
  kind?: AiProviderKind;
  paid?: boolean;
  reportsCost?: boolean;
  configured?: boolean;
  fallback?: Handler;
} = {}): FakeAdapter {
  const kind = opts.kind ?? 'ollama';
  const paid = opts.paid ?? false;
  const capabilities: ProviderCapabilities = {
    kind,
    label: `Fake ${kind}`,
    local: !paid,
    paid,
    generatesText: true,
    reportsTokenUsage: 'full',
    reportsCost: opts.reportsCost ?? false,
    listsModels: true,
    structuredOutput: true,
    quotaInfo: 'none',
    requiresApiKey: false,
    notes: ['TEST FIXTURE adapter'],
  };
  const a: FakeAdapter = {
    kind,
    capabilities,
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    script: [],
    fallback: opts.fallback ?? (() => betDecision([{ type: 'red', stake: 100 }])),
    check: () => ({ configured: opts.configured ?? true, enabled: opts.configured ?? true, issues: [] }),
    testConnection: async () => ({ ok: true, testedAt: new Date(0).toISOString(), latencyMs: 1, message: 'fixture ok' }),
    listModels: async () => ['fixture-model'],
    async decide(req, cfg, signal) {
      a.calls.push({ req, cfg, signal });
      const n = a.calls.length;
      a.inFlight++;
      a.maxInFlight = Math.max(a.maxInFlight, a.inFlight);
      try {
        const h = a.script.shift() ?? a.fallback;
        return await h(req, signal, n);
      } finally {
        a.inFlight--;
      }
    },
  };
  return a;
}

// ───────────────────────────── harness ─────────────────────────────

/** Deterministic (repeating) outcome script long enough for any test here. */
export function outcomeScript(n = 500): number[] {
  const base = [17, 0, 32, 5, 12, 36, 1, 20, 9, 26];
  return Array.from({ length: n }, (_, i) => base[i % base.length]!);
}

export interface Harness {
  repo: Repository;
  service: ReturnType<typeof createGameService>;
  outcome: OutcomeSource & { calls: number };
  clock: { t: number; advance(ms: number): void };
  sleeps: number[];
  events: ServerEvent[];
  adapters: Map<AiProviderKind, ProviderAdapter>;
  key(): string;
}

export function makeHarness(opts: {
  adapters?: ProviderAdapter[];
  outcomes?: number[];
  config?: AppConfig;
  repo?: Repository;
  outcomeSource?: OutcomeSource & { calls: number };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Wait between autonomous rounds; default 0 (instant tests). Pass defaultRoundPacingMs for the real rule. */
  presentationDelayMs?: (settings: AppSettings) => number;
} = {}): Harness {
  const clock = {
    t: Date.parse('2026-09-23T12:00:00.000Z'),
    advance(ms: number) {
      clock.t += ms;
    },
  };
  const now = () => new Date(clock.t);
  const repo = opts.repo ?? openRepository(':memory:', { now, appVersion: 'test' });
  const outcome = opts.outcomeSource ?? createFixtureOutcomeSource(opts.outcomes ?? outcomeScript());
  const sleeps: number[] = [];
  const sleep =
    opts.sleep ??
    (async (ms: number) => {
      sleeps.push(ms);
    });
  const adapters = new Map<AiProviderKind, ProviderAdapter>((opts.adapters ?? []).map((a) => [a.kind, a]));
  const service = createGameService({
    config: opts.config ?? testConfig(),
    repo,
    adapters,
    outcomeSource: outcome,
    now,
    sleep,
    presentationDelayMs: opts.presentationDelayMs ?? (() => 0),
  });
  let k = 0;
  return { repo, service, outcome, clock, sleeps, events: [], adapters, key: () => `key-${++k}` };
}
