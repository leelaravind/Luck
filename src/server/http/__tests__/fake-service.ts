/**
 * TEST FIXTURE ONLY — a minimal in-memory GameService used by the HTTP-layer tests.
 * It records every call and returns fixed fixture data; it implements no game rules.
 */
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  GameError,
  type AppSettings,
  type ServerEvent,
  type SessionInfo,
  type SessionSnapshot,
  type UsageSummary,
} from '../../../shared/contracts.js';
import { findRepoRoot } from '../../config.js';
import type { AppConfig, GameService } from '../../types.js';

export const FIXTURE_SESSION_ID = 'sess_fixture_1';

export function fixtureSession(id = FIXTURE_SESSION_ID): SessionInfo {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id,
    name: 'Fixture session',
    mode: 'manual',
    player: { kind: 'manual' },
    status: 'ready',
    phase: 'ready',
    pauseReason: null,
    endReason: null,
    message: null,
    balance: DEFAULT_LIMITS.startingBalance,
    startingBalance: DEFAULT_LIMITS.startingBalance,
    roundsPlayed: 0,
    limits: { ...DEFAULT_LIMITS },
    epoch: 0,
    createdAt: at,
    updatedAt: at,
    runtimeMs: 0,
  };
}

export function fixtureUsage(): UsageSummary {
  return {
    requests: 0,
    failedRequests: 0,
    unknownUsageRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    costIsPartial: false,
    costBasis: 'not-applicable',
    lastLatencyMs: null,
    avgLatencyMs: null,
    lastOutputTokensPerSec: null,
    budgetMicros: null,
    budgetRemainingMicros: null,
    lastRateLimit: null,
  };
}

export function fixtureSnapshot(id = FIXTURE_SESSION_ID): SessionSnapshot {
  return {
    session: fixtureSession(id),
    currentRound: null,
    recentRounds: [],
    lastDecision: null,
    usage: fixtureUsage(),
    inFlight: { decision: false, round: false },
  };
}

export function fixtureSettings(): AppSettings {
  return { defaultLimits: { ...DEFAULT_LIMITS }, animationSpeed: 'normal', reduceMotion: 'system', pricing: {}, players: {} };
}

export interface FakeService extends GameService {
  /** Every call as [method, ...args]. */
  calls: [string, ...unknown[]][];
  /** Push an event to every subscriber of a session. */
  emit(sessionId: string, ev: ServerEvent): void;
  subscriberCount(sessionId: string): number;
}

export function createFakeService(overrides: Partial<GameService> = {}): FakeService {
  const calls: [string, ...unknown[]][] = [];
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  const known = (id: string) => id === FIXTURE_SESSION_ID;

  const base: GameService = {
    listProviders: () => (calls.push(['listProviders']), []),
    testProvider: async (kind, player) => {
      calls.push(['testProvider', kind, player]);
      return { ok: false, testedAt: '2026-01-01T00:00:00.000Z', latencyMs: null, message: 'fixture: not a real connection' };
    },
    listModels: async (kind, player) => (calls.push(['listModels', kind, player]), []),
    getSettings: () => (calls.push(['getSettings']), fixtureSettings()),
    updateSettings: (patch) => (calls.push(['updateSettings', patch]), { ...fixtureSettings(), ...patch }),
    listSessions: () => (calls.push(['listSessions']), [fixtureSession()]),
    createSession: (req, key) => (calls.push(['createSession', req, key]), fixtureSnapshot()),
    getSnapshot: (id) => {
      calls.push(['getSnapshot', id]);
      if (!known(id)) throw makeNotFound(id);
      return fixtureSnapshot(id);
    },
    placeManualRound: (id, bets, key) => {
      calls.push(['placeManualRound', id, bets, key]);
      throw makeNotFound(id);
    },
    control: async (id, action, key) => (calls.push(['control', id, action, key]), fixtureSnapshot(id)),
    listRounds: (id, opts) => (calls.push(['listRounds', id, opts]), []),
    listDecisions: (id, limit) => (calls.push(['listDecisions', id, limit]), []),
    getUsage: (id) => (calls.push(['getUsage', id]), { records: [], summary: fixtureUsage() }),
    listLogs: (id, limit) => (calls.push(['listLogs', id, limit]), []),
    exportSession: (id, format) => {
      calls.push(['exportSession', id, format]);
      return format === 'csv'
        ? { filename: `luck-${id}.csv`, contentType: 'text/csv; charset=utf-8', body: 'seq,winningNumber\n' }
        : { filename: `luck-${id}.json`, contentType: 'application/json; charset=utf-8', body: '{"fixture":true}' };
    },
    subscribe: (id, listener) => {
      calls.push(['subscribe', id]);
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        calls.push(['unsubscribe', id]);
        set.delete(listener);
      };
    },
    recover: () => ({ settledRounds: 0, pausedSessions: 0, interruptedDecisions: 0 }),
    shutdown: async () => undefined,
  };

  return Object.assign(base, overrides, {
    calls,
    emit(sessionId: string, ev: ServerEvent) {
      for (const l of listeners.get(sessionId) ?? []) l(ev);
    },
    subscriberCount(sessionId: string) {
      return listeners.get(sessionId)?.size ?? 0;
    },
  });
}

/** Unknown sessions behave like the real service: GameError('not_found'). */
function makeNotFound(id: string): GameError {
  return new GameError('not_found', `Session ${id} not found`);
}

/** AppConfig for tests. No real keys; webDistDir points at a folder that does not exist unless a test creates it. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const repoTmp = join(findRepoRoot(), 'tmp', '1');
  return {
    version: '0.0.0-test',
    host: '127.0.0.1',
    port: 3717,
    devOrigins: [],
    isDev: false,
    dataDir: join(repoTmp, 'data'),
    dbPath: join(repoTmp, 'data', 'luck.db'),
    webDistDir: join(repoTmp, 'no-web-build'),
    providers: {
      ollama: { baseUrl: 'http://127.0.0.1:11434' },
      anthropic: { baseUrl: 'https://api.anthropic.com' },
      openai: {},
      claudeCli: { enabled: false, useSubscriptionAuth: true },
      laya: { baseUrl: 'http://127.0.0.1:8000', checkpoint: 'english' },
    },
    ...overrides,
  };
}

/** Headers a legitimate same-origin browser request carries (production, single port). */
export const OK_HEADERS = { host: '127.0.0.1:3717' } as const;
export const OK_POST_HEADERS = { host: '127.0.0.1:3717', 'x-luck-client': '1', 'content-type': 'application/json' } as const;
