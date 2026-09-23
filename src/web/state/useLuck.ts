/**
 * useLuck() — the dashboard's single source of client state.
 *
 * Loads providers / settings / sessions, the selected session's snapshot and lists, subscribes to the
 * session's SSE stream, and exposes guarded actions (a second click while a request is in flight is
 * ignored). All money values come from the server; the only client-side decision is WHEN a settled
 * result becomes visible (see reveal.ts).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  AiProviderKind,
  AnimationSpeed,
  AppSettings,
  BetInput,
  ControlAction,
  CreateSessionRequest,
  PlayerConfig,
  RoundRecord,
  ServerEvent,
  SessionInfo,
} from '../../shared/contracts';
import { ApiError, createApiClient, errorMessage, type ApiClient } from '../api/client';
import { useEventStream } from '../hooks/useEventStream';
import { isPageHidden, usePageHidden } from '../hooks/usePageVisibility';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { formatCredits, pocketLabel } from './format';
import { INITIAL_STATE, luckReducer, type ErrorScope, type LastError } from './luckReducer';
import { present, type Presentation } from './reveal';
import { readStored, STORAGE_KEYS, writeStored } from './storage';

/** If the wheel never reports onSettled (bug, unmounted), reveal anyway after this long. */
export const REVEAL_WATCHDOG_MS: Record<AnimationSpeed, number> = { normal: 20_000, fast: 10_000, instant: 2_000 };

const ROUND_PAGE = 200;
const MAX_ROUND_PAGES = 5;
const HEALTH_POLL_MS = 15_000;

export interface UseLuckOptions {
  /** Injected for tests. */
  readonly api?: ApiClient;
}

function toLastError(scope: ErrorScope, err: unknown, kind?: AiProviderKind): LastError {
  if (err instanceof ApiError) {
    return { scope, code: err.code, message: err.message, status: err.status, details: err.details, kind };
  }
  return { scope, code: 'internal', message: errorMessage(err), status: 0, kind };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Newest-first list of every round (paged with beforeSeq), capped for very long sessions. */
async function fetchRounds(api: ApiClient, id: string, signal?: AbortSignal): Promise<RoundRecord[]> {
  const all: RoundRecord[] = [];
  let beforeSeq: number | undefined;
  for (let page = 0; page < MAX_ROUND_PAGES; page++) {
    const { rounds } = await api.listRounds(id, { limit: ROUND_PAGE, beforeSeq }, signal);
    all.push(...rounds);
    if (rounds.length < ROUND_PAGE) break;
    beforeSeq = rounds[rounds.length - 1]!.seq;
  }
  return all;
}

function pickInitialSession(sessions: readonly SessionInfo[]): string | null {
  const stored = readStored(STORAGE_KEYS.selectedSessionId);
  if (stored && sessions.some((s) => s.id === stored)) return stored;
  const newest = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest?.id ?? null;
}

export function useLuck(opts: UseLuckOptions = {}) {
  const api = useMemo(() => opts.api ?? createApiClient(), [opts.api]);
  const [state, dispatch] = useReducer(luckReducer, INITIAL_STATE);
  const [announcement, setAnnouncement] = useState('');

  const speed: AnimationSpeed = state.settings?.animationSpeed ?? 'normal';
  const reducedMotion = useReducedMotion(state.settings?.reduceMotion ?? 'system');
  const pageHidden = usePageHidden();

  // Evaluated at dispatch time: should a newly known outcome skip the animation?
  const motionRef = useRef({ reducedMotion, speed });
  motionRef.current = { reducedMotion, speed };
  const immediate = useCallback(
    () => isPageHidden() || motionRef.current.reducedMotion || motionRef.current.speed === 'instant',
    [],
  );

  // Guards against repeated clicks, independent of render timing.
  const inflight = useRef(new Set<string>());
  const guard = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (inflight.current.has(key)) return undefined;
    inflight.current.add(key);
    try {
      return await fn();
    } finally {
      inflight.current.delete(key);
    }
  }, []);

  const fail = useCallback((scope: ErrorScope, err: unknown, kind?: AiProviderKind) => {
    if (isAbort(err)) return;
    dispatch({ type: 'error', error: toLastError(scope, err, kind) });
  }, []);

  // ───────────── bootstrap ─────────────
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const [health, providers, settings, sessions] = await Promise.allSettled([
        api.health(ac.signal),
        api.listProviders(ac.signal),
        api.getSettings(ac.signal),
        api.listSessions(ac.signal),
      ]);
      if (ac.signal.aborted) return;
      dispatch({ type: 'health', health: health.status === 'fulfilled' ? health.value : null });
      if (providers.status === 'fulfilled') dispatch({ type: 'providers', providers: providers.value.providers });
      if (settings.status === 'fulfilled') dispatch({ type: 'settings', settings: settings.value });
      if (sessions.status === 'fulfilled') {
        dispatch({ type: 'sessions', sessions: sessions.value.sessions });
        dispatch({ type: 'select', sessionId: pickInitialSession(sessions.value.sessions) });
      }
      const firstFailure = [providers, settings, sessions].find((r) => r.status === 'rejected');
      if (firstFailure && firstFailure.status === 'rejected') fail('load', firstFailure.reason);
      dispatch({ type: 'busy', patch: { booting: false } });
    })();
    return () => ac.abort();
  }, [api, fail]);

  // ───────────── selected session: load snapshot + lists ─────────────
  const selectedId = state.selectedSessionId;
  useEffect(() => {
    if (!selectedId) return;
    writeStored(STORAGE_KEYS.selectedSessionId, selectedId);
    const ac = new AbortController();
    dispatch({ type: 'busy', patch: { sessionLoading: true } });
    void (async () => {
      try {
        const [snapshot, rounds, decisions, logs, usage] = await Promise.all([
          api.getSession(selectedId, ac.signal),
          fetchRounds(api, selectedId, ac.signal),
          api.listDecisions(selectedId, 100, ac.signal),
          api.listLogs(selectedId, 200, ac.signal),
          api.getUsage(selectedId, ac.signal),
        ]);
        dispatch({
          type: 'sessionLoaded',
          snapshot,
          rounds,
          decisions: decisions.decisions,
          logs: logs.logs,
          usage: usage.records,
        });
      } catch (err) {
        fail('session', err);
      } finally {
        if (!ac.signal.aborted) dispatch({ type: 'busy', patch: { sessionLoading: false } });
      }
    })();
    return () => ac.abort();
  }, [api, selectedId, fail]);

  /** Catch up after the event stream dropped (events may have been missed). */
  const refreshSession = useCallback(async () => {
    const id = state.selectedSessionId;
    if (!id) return;
    try {
      const [snapshot, rounds, decisions, logs, usage] = await Promise.all([
        api.getSession(id),
        api.listRounds(id, { limit: 50 }),
        api.listDecisions(id, 50),
        api.listLogs(id, 100),
        api.getUsage(id),
      ]);
      const now = immediate();
      dispatch({ type: 'rounds', rounds: rounds.rounds, immediate: now });
      dispatch({ type: 'snapshot', snapshot, immediate: now });
      dispatch({ type: 'decisions', decisions: decisions.decisions });
      dispatch({ type: 'logs', logs: logs.logs });
      dispatch({ type: 'usage', records: usage.records });
    } catch (err) {
      fail('session', err);
    }
  }, [api, state.selectedSessionId, immediate, fail]);

  // ───────────── live events ─────────────
  const loaded = !!state.snapshot && state.snapshot.session.id === state.selectedSessionId;
  const onEvent = useCallback(
    (ev: ServerEvent) => {
      dispatch({ type: 'eventReceived', at: new Date().toISOString() });
      switch (ev.type) {
        case 'snapshot':
          dispatch({ type: 'snapshot', snapshot: ev.snapshot, immediate: immediate() });
          break;
        case 'round':
          dispatch({ type: 'rounds', rounds: [ev.round], immediate: immediate() });
          break;
        case 'decision':
          dispatch({ type: 'decisions', decisions: [ev.decision] });
          break;
        case 'usage':
          dispatch({ type: 'usage', records: [ev.usage] });
          break;
        case 'log':
          dispatch({ type: 'logs', logs: [ev.log] });
          break;
        case 'heartbeat':
          break;
      }
    },
    [immediate],
  );
  useEventStream({
    url: loaded && selectedId ? api.eventsUrl(selectedId) : null,
    onEvent,
    onStatus: (status) => dispatch({ type: 'connection', status }),
    onOpen: (afterDrop) => {
      if (afterDrop) void refreshSession();
    },
  });

  // Honest server indicator when no live stream: poll /api/health.
  useEffect(() => {
    if (state.connection === 'live') return;
    const t = setInterval(() => {
      api.health().then(
        (h) => dispatch({ type: 'health', health: h }),
        () => dispatch({ type: 'health', health: null }),
      );
    }, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [api, state.connection]);

  // ───────────── reveal side effects ─────────────
  useEffect(() => {
    if (pageHidden || reducedMotion) dispatch({ type: 'revealFlush' });
  }, [pageHidden, reducedMotion]);

  const spinningId = state.reveal.spinning?.roundId ?? null;
  useEffect(() => {
    if (!spinningId) return;
    const t = setTimeout(() => dispatch({ type: 'wheelSettled', roundId: spinningId }), REVEAL_WATCHDOG_MS[speed]);
    return () => clearTimeout(t);
  }, [spinningId, speed]);

  const onWheelSettled = useCallback((roundId: string) => dispatch({ type: 'wheelSettled', roundId }), []);

  const presentation: Presentation | null = useMemo(
    () => (state.snapshot ? present(state.snapshot.session, state.rounds, state.reveal) : null),
    [state.snapshot, state.rounds, state.reveal],
  );

  // Announce newly revealed results (never the history present at load time).
  const announced = useRef<{ sessionId: string | null; seq: number }>({ sessionId: null, seq: 0 });
  const lastRound = presentation?.lastRound ?? null;
  const sessionId = state.snapshot?.session.id ?? null;
  useEffect(() => {
    if (!presentation || !sessionId) return;
    if (announced.current.sessionId !== sessionId) {
      announced.current = { sessionId, seq: presentation.revealedSeq };
      return;
    }
    if (lastRound && lastRound.seq > announced.current.seq) {
      announced.current.seq = lastRound.seq;
      if (lastRound.winningNumber !== null && lastRound.net !== null && lastRound.balanceAfter !== null) {
        setAnnouncement(
          `Round ${lastRound.seq}: ${pocketLabel(lastRound.winningNumber)}. ` +
            `Net ${formatCredits(lastRound.net, { sign: true })}. Balance ${formatCredits(lastRound.balanceAfter)}.`,
        );
      }
    }
  }, [presentation, lastRound, sessionId]);

  // ───────────── actions ─────────────
  const selectSession = useCallback((id: string | null) => dispatch({ type: 'select', sessionId: id }), []);

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await api.listSessions();
      dispatch({ type: 'sessions', sessions });
    } catch (err) {
      fail('load', err);
    }
  }, [api, fail]);

  const refreshProviders = useCallback(async () => {
    try {
      const { providers } = await api.listProviders();
      dispatch({ type: 'providers', providers });
    } catch (err) {
      fail('provider', err);
    }
  }, [api, fail]);

  const createSession = useCallback(
    async (req: CreateSessionRequest): Promise<boolean> =>
      (await guard('create', async () => {
        dispatch({ type: 'busy', patch: { creating: true } });
        try {
          const snapshot = await api.createSession(req);
          // Not selected yet, so this only adds the new session to the list; selecting then loads it.
          dispatch({ type: 'snapshot', snapshot, immediate: true });
          dispatch({ type: 'select', sessionId: snapshot.session.id });
          dispatch({ type: 'error', error: null });
          return true;
        } catch (err) {
          fail('create', err);
          return false;
        } finally {
          dispatch({ type: 'busy', patch: { creating: false } });
        }
      })) ?? false,
    [api, guard, fail],
  );

  const placeRound = useCallback(
    async (bets: BetInput[]): Promise<boolean> => {
      const id = state.selectedSessionId;
      if (!id) return false;
      return (
        (await guard('round', async () => {
          dispatch({ type: 'busy', patch: { round: true } });
          try {
            const res = await api.placeManualRound(id, bets);
            const now = immediate();
            dispatch({ type: 'rounds', rounds: [res.round], immediate: now });
            dispatch({ type: 'snapshot', snapshot: res.snapshot, immediate: now });
            dispatch({ type: 'error', error: null });
            return true;
          } catch (err) {
            fail('round', err);
            return false;
          } finally {
            dispatch({ type: 'busy', patch: { round: false } });
          }
        })) ?? false
      );
    },
    [api, guard, fail, immediate, state.selectedSessionId],
  );

  const control = useCallback(
    async (action: ControlAction): Promise<void> => {
      const id = state.selectedSessionId;
      if (!id) return;
      await guard('control', async () => {
        dispatch({ type: 'busy', patch: { control: action } });
        try {
          const snapshot = await api.control(id, action);
          dispatch({ type: 'snapshot', snapshot, immediate: immediate() });
          dispatch({ type: 'error', error: null });
        } catch (err) {
          fail('control', err);
        } finally {
          dispatch({ type: 'busy', patch: { control: null } });
        }
      });
    },
    [api, guard, fail, immediate, state.selectedSessionId],
  );

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>): Promise<boolean> =>
      (await guard('settings', async () => {
        dispatch({ type: 'busy', patch: { settings: true } });
        try {
          const settings = await api.updateSettings(patch);
          dispatch({ type: 'settings', settings });
          return true;
        } catch (err) {
          fail('settings', err);
          return false;
        } finally {
          dispatch({ type: 'busy', patch: { settings: false } });
        }
      })) ?? false,
    [api, guard, fail],
  );

  /**
   * Presentation-only preference; applied locally at once, then persisted. Not guarded like other saves:
   * rapid changes each send a PUT and the most recent choice always wins locally.
   */
  const latestSpeed = useRef<AnimationSpeed | null>(null);
  const setAnimationSpeed = useCallback(
    (animationSpeed: AnimationSpeed) => {
      latestSpeed.current = animationSpeed;
      if (state.settings) dispatch({ type: 'settings', settings: { ...state.settings, animationSpeed } });
      api.updateSettings({ animationSpeed }).then(
        (settings) => dispatch({ type: 'settings', settings: { ...settings, animationSpeed: latestSpeed.current ?? settings.animationSpeed } }),
        (err) => fail('settings', err),
      );
    },
    [api, state.settings, fail],
  );

  const testProvider = useCallback(
    async (kind: AiProviderKind, player?: PlayerConfig) => {
      await guard(`test:${kind}`, async () => {
        dispatch({ type: 'busyProvider', field: 'testing', kind, value: true });
        try {
          const result = await api.testProvider(kind, player);
          dispatch({ type: 'providerTest', kind, result });
          if (result.models?.length) dispatch({ type: 'providerModels', kind, models: result.models });
          if (state.lastError?.scope === 'provider' && state.lastError.kind === kind) {
            dispatch({ type: 'error', error: null });
          }
        } catch (err) {
          fail('provider', err, kind);
        } finally {
          dispatch({ type: 'busyProvider', field: 'testing', kind, value: false });
        }
      });
      void refreshProviders();
    },
    [api, guard, fail, refreshProviders, state.lastError],
  );

  const loadModels = useCallback(
    async (kind: AiProviderKind, player?: PlayerConfig) => {
      await guard(`models:${kind}`, async () => {
        dispatch({ type: 'busyProvider', field: 'models', kind, value: true });
        try {
          const { models } = await api.listModels(kind, player);
          dispatch({ type: 'providerModels', kind, models });
        } catch (err) {
          fail('provider', err, kind);
        } finally {
          dispatch({ type: 'busyProvider', field: 'models', kind, value: false });
        }
      });
    },
    [api, guard, fail],
  );

  const clearError = useCallback(() => dispatch({ type: 'error', error: null }), []);

  return {
    state,
    api,
    presentation,
    announcement,
    speed,
    reducedMotion,
    actions: {
      selectSession,
      refreshSessions,
      refreshProviders,
      createSession,
      placeRound,
      control,
      saveSettings,
      setAnimationSpeed,
      testProvider,
      loadModels,
      onWheelSettled,
      clearError,
    },
  };
}

export type LuckStore = ReturnType<typeof useLuck>;
