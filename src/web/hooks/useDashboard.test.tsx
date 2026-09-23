// @vitest-environment jsdom
/**
 * useDashboard settings writes (FIXTURE DATA ONLY: fetch and EventSource are mocked, no server): creating
 * an AI session remembers only THAT provider's non-secret config, so a stale copy of the other providers'
 * entries is never written back over newer ones (the server merges players key by key).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PlayerConfig } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { createApiClient } from '../api/client';
import { fixtureSession, fixtureSnapshot, fixtureUsage } from '../state/testFixtures';
import { useDashboard } from './useDashboard';

class SilentEventSource {
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useDashboard: remembering the last-used player', () => {
  it('sends only the created provider entry, never a stale copy of the others', async () => {
    const olderOpenai: PlayerConfig = { kind: 'openai', model: 'stale-tab-fixture-model' };
    const settings: AppSettings = {
      defaultLimits: DEFAULT_LIMITS,
      animationSpeed: 'normal',
      roundPacingMs: 7000,
      reduceMotion: 'off',
      pricing: {},
      players: { openai: olderOpenai },
    };
    const player: PlayerConfig = { kind: 'ollama', model: 'fixture-model', baseUrl: 'http://127.0.0.1:11434' };
    const session = fixtureSession({ mode: 'ai', player });
    const snapshot = fixtureSnapshot(session, [], { usage: fixtureUsage() });
    const puts: unknown[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/health') return json({ ok: true, version: 'test' });
      if (url === '/api/providers') return json({ providers: [] });
      if (url === '/api/settings' && method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)));
        return json(settings);
      }
      if (url === '/api/settings') return json(settings);
      if (url === '/api/sessions' && method === 'POST') return json(snapshot);
      if (url === '/api/sessions') return json({ sessions: [] });
      if (url === `/api/sessions/${session.id}`) return json(snapshot);
      if (url.startsWith(`/api/sessions/${session.id}/rounds`)) return json({ rounds: [] });
      if (url.startsWith(`/api/sessions/${session.id}/decisions`)) return json({ decisions: [] });
      if (url.startsWith(`/api/sessions/${session.id}/logs`)) return json({ logs: [] });
      if (url.startsWith(`/api/sessions/${session.id}/usage`)) return json({ records: [], summary: snapshot.usage });
      return json({ error: { code: 'not_found', message: `No fixture for ${method} ${url}` } }, 404);
    }) as unknown as typeof globalThis.fetch;

    const api = createApiClient({ fetch }); // one client: a new one per render would restart the bootstrap
    const { result } = renderHook(() => useDashboard(api));
    await waitFor(() => expect(result.current.store.state.settings).not.toBeNull());
    await act(() => result.current.dialog.onCreate({ player }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ players: { ollama: player } });
  });
});
