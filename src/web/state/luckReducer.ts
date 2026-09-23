/**
 * Client store for the dashboard. Pure reducer: every server payload (HTTP responses and SSE events)
 * goes through here so rounds, snapshot and the reveal watermark change atomically — a round's result
 * can never flash on screen before the reveal logic has decided to hide it.
 *
 * The store only mirrors server state. It never computes balances, payouts or outcomes itself; the
 * presentation layer (reveal.ts) merely chooses WHEN an already-settled result becomes visible.
 */
import type {
  AiProviderKind,
  AppSettings,
  ConnectionTestResult,
  ControlAction,
  DecisionRecord,
  LogEntry,
  ProviderStatus,
  RoundRecord,
  RoundStatus,
  SessionInfo,
  SessionSnapshot,
  UsageRecord,
} from '../../shared/contracts';
import type { HealthResponse } from '../api/client';
import {
  INITIAL_REVEAL,
  revealFlush,
  revealOutcome,
  revealReset,
  revealSettled,
  type RevealState,
} from './reveal';

/** Real EventSource state for the selected session's event stream. */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface BusyFlags {
  /** Initial load of providers/settings/sessions. */
  booting: boolean;
  /** Selected session's snapshot + lists are loading. */
  sessionLoading: boolean;
  creating: boolean;
  /** Manual round request in flight. */
  round: boolean;
  /** Control request in flight (start/pause/stop/step). */
  control: ControlAction | null;
  settings: boolean;
  testing: Partial<Record<AiProviderKind, boolean>>;
  models: Partial<Record<AiProviderKind, boolean>>;
}

export type ErrorScope = 'load' | 'session' | 'round' | 'control' | 'create' | 'settings' | 'provider';

export interface LastError {
  scope: ErrorScope;
  code: string;
  message: string;
  status: number;
  details?: unknown;
  /** Provider kind for scope 'provider'. */
  kind?: AiProviderKind;
}

export interface LuckState {
  health: HealthResponse | null;
  /** null until the first health check finished. */
  serverReachable: boolean | null;
  providers: ProviderStatus[];
  /** Connection tests run from this page (newer than ProviderStatus.lastTest). */
  providerTests: Partial<Record<AiProviderKind, ConnectionTestResult>>;
  providerModels: Partial<Record<AiProviderKind, string[]>>;
  settings: AppSettings | null;
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  snapshot: SessionSnapshot | null;
  /** Newest first. Includes snapshot.currentRound / recentRounds. */
  rounds: RoundRecord[];
  /** Newest first. */
  decisions: DecisionRecord[];
  /** Newest first. */
  logs: LogEntry[];
  /** Oldest first (API order). */
  usageRecords: UsageRecord[];
  connection: ConnectionStatus;
  /** Receipt time of the last SSE frame (any type). */
  lastEventAt: string | null;
  busy: BusyFlags;
  lastError: LastError | null;
  reveal: RevealState;
}

export const INITIAL_STATE: LuckState = {
  health: null,
  serverReachable: null,
  providers: [],
  providerTests: {},
  providerModels: {},
  settings: null,
  sessions: [],
  selectedSessionId: null,
  snapshot: null,
  rounds: [],
  decisions: [],
  logs: [],
  usageRecords: [],
  connection: 'offline',
  lastEventAt: null,
  busy: {
    booting: true,
    sessionLoading: false,
    creating: false,
    round: false,
    control: null,
    settings: false,
    testing: {},
    models: {},
  },
  lastError: null,
  reveal: INITIAL_REVEAL,
};

export type LuckAction =
  | { type: 'health'; health: HealthResponse | null }
  | { type: 'providers'; providers: ProviderStatus[] }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'select'; sessionId: string | null }
  | {
      type: 'sessionLoaded';
      snapshot: SessionSnapshot;
      rounds: RoundRecord[];
      decisions: DecisionRecord[];
      logs: LogEntry[];
      usage: UsageRecord[];
    }
  /** A newer snapshot / rounds from the server. `immediate` = reveal without animation. */
  | { type: 'snapshot'; snapshot: SessionSnapshot; immediate: boolean }
  | { type: 'rounds'; rounds: RoundRecord[]; immediate: boolean }
  | { type: 'decisions'; decisions: DecisionRecord[] }
  | { type: 'usage'; records: UsageRecord[] }
  | { type: 'logs'; logs: LogEntry[] }
  /** Any SSE frame arrived; `at` is the receipt time in the browser. */
  | { type: 'eventReceived'; at: string }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'busy'; patch: Partial<Omit<BusyFlags, 'testing' | 'models'>> }
  | { type: 'busyProvider'; field: 'testing' | 'models'; kind: AiProviderKind; value: boolean }
  | { type: 'error'; error: LastError | null }
  | { type: 'providerTest'; kind: AiProviderKind; result: ConnectionTestResult }
  | { type: 'providerModels'; kind: AiProviderKind; models: string[] }
  | { type: 'wheelSettled'; roundId: string }
  | { type: 'revealFlush' };

const MAX_LOGS = 500;
const MAX_DECISIONS = 200;

const STATUS_RANK: Record<RoundStatus, number> = { committed: 0, outcome_recorded: 1, settled: 2 };

/** Upsert rounds by id; a record never regresses to an earlier lifecycle status. Newest first. */
export function mergeRounds(existing: readonly RoundRecord[], incoming: readonly RoundRecord[]): RoundRecord[] {
  if (!incoming.length) return existing as RoundRecord[];
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of incoming) {
    const old = byId.get(r.id);
    if (!old || STATUS_RANK[r.status] >= STATUS_RANK[old.status]) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}

function mergeById<T extends { id: string | number }>(
  existing: readonly T[],
  incoming: readonly T[],
  compare: (a: T, b: T) => number,
  max: number,
): T[] {
  if (!incoming.length) return existing as T[];
  const byId = new Map<string | number, T>(existing.map((x) => [x.id, x]));
  for (const x of incoming) byId.set(x.id, x);
  return [...byId.values()].sort(compare).slice(0, max);
}

const newestDecisionFirst = (a: DecisionRecord, b: DecisionRecord) =>
  b.startedAt.localeCompare(a.startedAt) || b.roundNumber - a.roundNumber;
const newestLogFirst = (a: LogEntry, b: LogEntry) => b.id - a.id;
const oldestUsageFirst = (a: UsageRecord, b: UsageRecord) => a.createdAt.localeCompare(b.createdAt);

function snapshotRounds(s: SessionSnapshot): RoundRecord[] {
  return s.currentRound ? [...s.recentRounds, s.currentRound] : [...s.recentRounds];
}

function upsertSession(list: readonly SessionInfo[], info: SessionInfo): SessionInfo[] {
  const i = list.findIndex((s) => s.id === info.id);
  if (i < 0) return [info, ...list];
  const next = list.slice();
  next[i] = info;
  return next;
}

/** Feed outcomes (oldest first) to the reveal state machine. */
function ingestOutcomes(reveal: RevealState, rounds: readonly RoundRecord[], immediate: boolean): RevealState {
  let r = reveal;
  for (const round of [...rounds].sort((a, b) => a.seq - b.seq)) r = revealOutcome(r, round, immediate);
  return r;
}

export function luckReducer(state: LuckState, action: LuckAction): LuckState {
  switch (action.type) {
    case 'health':
      return { ...state, health: action.health, serverReachable: action.health !== null };

    case 'providers':
      return { ...state, providers: action.providers };

    case 'settings':
      return { ...state, settings: action.settings };

    case 'sessions': {
      // Keep the live snapshot's session info authoritative for the selected session.
      const live = state.snapshot?.session;
      const sessions = live ? upsertSession(action.sessions, live) : action.sessions;
      return { ...state, sessions };
    }

    case 'select':
      if (action.sessionId === state.selectedSessionId && state.snapshot) return state;
      return {
        ...state,
        selectedSessionId: action.sessionId,
        snapshot: null,
        rounds: [],
        decisions: [],
        logs: [],
        usageRecords: [],
        connection: 'offline',
        lastEventAt: null,
        reveal: revealReset(action.sessionId, []),
        lastError: state.lastError?.scope === 'round' || state.lastError?.scope === 'control' ? null : state.lastError,
      };

    case 'sessionLoaded': {
      const s = action.snapshot;
      if (s.session.id !== state.selectedSessionId) return state;
      const rounds = mergeRounds(action.rounds, snapshotRounds(s));
      return {
        ...state,
        snapshot: s,
        sessions: upsertSession(state.sessions, s.session),
        rounds,
        decisions: mergeById(
          [],
          s.lastDecision ? [...action.decisions, s.lastDecision] : action.decisions,
          newestDecisionFirst,
          MAX_DECISIONS,
        ),
        logs: mergeById([], action.logs, newestLogFirst, MAX_LOGS),
        usageRecords: mergeById([], action.usage, oldestUsageFirst, Number.MAX_SAFE_INTEGER),
        // Everything known at load time is history: no animation, wheel idle.
        reveal: revealReset(s.session.id, rounds),
      };
    }

    case 'snapshot': {
      const s = action.snapshot;
      const sessions = upsertSession(state.sessions, s.session);
      if (s.session.id !== state.selectedSessionId || !state.snapshot) return { ...state, sessions };
      const incoming = snapshotRounds(s);
      const rounds = mergeRounds(state.rounds, incoming);
      // Out-of-order delivery (HTTP response vs SSE): never replace a newer snapshot with an older one.
      const stale = s.session.updatedAt < state.snapshot.session.updatedAt;
      const snapshot = stale ? state.snapshot : s;
      const decisions = s.lastDecision
        ? mergeById(state.decisions, [s.lastDecision], newestDecisionFirst, MAX_DECISIONS)
        : state.decisions;
      return {
        ...state,
        sessions: stale ? state.sessions : sessions,
        snapshot,
        rounds,
        decisions,
        reveal: ingestOutcomes(state.reveal, incoming, action.immediate),
      };
    }

    case 'rounds': {
      const own = action.rounds.filter((r) => r.sessionId === state.selectedSessionId);
      if (!own.length || !state.snapshot) return state;
      const rounds = mergeRounds(state.rounds, own);
      // Keep snapshot.currentRound in step with the newest round we know about.
      const latest = rounds[0]!;
      const cur = state.snapshot.currentRound;
      const snapshot =
        !cur || latest.seq > cur.seq || (latest.id === cur.id && STATUS_RANK[latest.status] >= STATUS_RANK[cur.status])
          ? { ...state.snapshot, currentRound: latest }
          : state.snapshot;
      return { ...state, rounds, snapshot, reveal: ingestOutcomes(state.reveal, own, action.immediate) };
    }

    case 'decisions': {
      const own = action.decisions.filter((d) => d.sessionId === state.selectedSessionId);
      if (!own.length || !state.snapshot) return state;
      const decisions = mergeById(state.decisions, own, newestDecisionFirst, MAX_DECISIONS);
      const newest = decisions[0]!;
      const last = state.snapshot.lastDecision;
      const snapshot =
        !last || newest.id === last.id || newestDecisionFirst(newest, last) < 0
          ? { ...state.snapshot, lastDecision: newest }
          : state.snapshot;
      return { ...state, decisions, snapshot };
    }

    case 'usage': {
      const own = action.records.filter((u) => u.sessionId === state.selectedSessionId);
      if (!own.length) return state;
      return { ...state, usageRecords: mergeById(state.usageRecords, own, oldestUsageFirst, Number.MAX_SAFE_INTEGER) };
    }

    case 'logs': {
      const own = action.logs.filter((l) => l.sessionId === state.selectedSessionId);
      if (!own.length) return state;
      return { ...state, logs: mergeById(state.logs, own, newestLogFirst, MAX_LOGS) };
    }

    case 'eventReceived':
      return { ...state, lastEventAt: action.at };

    case 'connection':
      return state.connection === action.status ? state : { ...state, connection: action.status };

    case 'busy':
      return { ...state, busy: { ...state.busy, ...action.patch } };

    case 'busyProvider':
      return {
        ...state,
        busy: { ...state.busy, [action.field]: { ...state.busy[action.field], [action.kind]: action.value } },
      };

    case 'error':
      return { ...state, lastError: action.error };

    case 'providerTest':
      return { ...state, providerTests: { ...state.providerTests, [action.kind]: action.result } };

    case 'providerModels':
      return { ...state, providerModels: { ...state.providerModels, [action.kind]: action.models } };

    case 'wheelSettled':
      return { ...state, reveal: revealSettled(state.reveal, action.roundId) };

    case 'revealFlush':
      return { ...state, reveal: revealFlush(state.reveal) };
  }
}
