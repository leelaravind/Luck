// @vitest-environment jsdom
/**
 * Settings freshness in useLuck (FIXTURE DATA ONLY: fetch is mocked, no server): refreshSettings re-reads
 * GET /api/settings, applies only a changed copy, stays quiet on failure, and never lets an older read
 * overwrite the response of a save that was started after it.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { createApiClient } from '../api/client';
import { sameSettings, useLuck } from './useLuck';

const BASE: AppSettings = {
  defaultLimits: DEFAULT_LIMITS,
  animationSpeed: 'normal',
  roundPacingMs: 7000,
  reduceMotion: 'off',
  pricing: { 'openai:fixture-model': { inputPerMTokUsd: 1, outputPerMTokUsd: 2, source: 'user', asOf: '2026-09-01' } },
  builtInPricingKeys: [],
  players: {},
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Reply = AppSettings | Error | Promise<AppSettings>;

/** fetch fake: GET /api/settings answers from `reads` (in order), PUT /api/settings from `writes`. */
function setup(reads: Reply[], writes: Reply[] = []) {
  const puts: unknown[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const answer = async (r: Reply | undefined) => {
    if (r === undefined) return json({ error: { code: 'internal', message: 'no fixture reply left' } }, 500);
    const v = await r;
    return v instanceof Error ? json({ error: { code: 'internal', message: v.message } }, 500) : json(v);
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/health') return json({ ok: true, version: 'test' });
    if (url === '/api/providers') return json({ providers: [] });
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/settings' && method === 'GET') return answer(reads.shift());
    if (url === '/api/settings' && method === 'PUT') {
      puts.push(JSON.parse(String(init?.body)));
      return answer(writes.shift());
    }
    return json({ error: { code: 'not_found', message: `No fixture for ${method} ${url}` } }, 404);
  }) as unknown as typeof globalThis.fetch;
  const api = createApiClient({ fetch });
  const hook = renderHook(() => useLuck({ api }));
  return { ...hook, puts };
}

afterEach(() => cleanup());

describe('sameSettings', () => {
  it('compares content, not key order or identity', () => {
    const reordered = Object.fromEntries(Object.entries(structuredClone(BASE)).reverse()) as unknown as AppSettings;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(BASE));
    expect(sameSettings(BASE, reordered)).toBe(true);
    expect(sameSettings(BASE, { ...BASE, roundPacingMs: 7100 })).toBe(false);
    expect(sameSettings(null, BASE)).toBe(false);
    expect(sameSettings(null, null)).toBe(true);
  });
});

describe('useLuck.refreshSettings', () => {
  it('applies a changed copy and keeps the current object when nothing changed', async () => {
    const newer: AppSettings = { ...BASE, pricing: { ...BASE.pricing, 'ollama:other-tab-fixture': { inputPerMTokUsd: 0, outputPerMTokUsd: 0, source: 'user' } } };
    const { result } = setup([BASE, structuredClone(BASE), newer]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());
    const loaded = result.current.state.settings;

    await act(() => result.current.actions.refreshSettings());
    expect(result.current.state.settings).toBe(loaded); // same content: no re-sync of an open form

    await act(() => result.current.actions.refreshSettings());
    expect(result.current.state.settings?.pricing).toHaveProperty(['ollama:other-tab-fixture']);
  });

  it('applyIf is checked when the answer arrives: typing that began during the read is not replaced', async () => {
    const slowRead = deferred<AppSettings>();
    const { result } = setup([BASE, slowRead.promise]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());
    const loaded = result.current.state.settings;

    let unsaved = false;
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.actions.refreshSettings({ applyIf: () => !unsaved });
    });
    unsaved = true; // the user starts typing before the answer arrives
    slowRead.resolve({ ...BASE, roundPacingMs: 9000 });
    await act(() => refresh);
    expect(result.current.state.settings).toBe(loaded);
  });

  it('is quiet on failure and keeps the current copy', async () => {
    const { result } = setup([BASE, new Error('fixture outage')]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());
    const loaded = result.current.state.settings;
    await act(() => result.current.actions.refreshSettings());
    expect(result.current.state.settings).toBe(loaded);
    expect(result.current.state.lastError).toBeNull();
  });

  it('a read answered after a save started never overwrites the save result', async () => {
    const slowRead = deferred<AppSettings>();
    const saved: AppSettings = { ...BASE, roundPacingMs: 2500 };
    const { result, puts } = setup([BASE, slowRead.promise], [saved]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.actions.refreshSettings();
    });
    await act(() => result.current.actions.saveSettings({ roundPacingMs: 2500 }));
    expect(puts).toEqual([{ roundPacingMs: 2500 }]);
    expect(result.current.state.settings?.roundPacingMs).toBe(2500);

    // The read started before the save now answers with the old copy: it is dropped.
    slowRead.resolve(BASE);
    await act(() => refresh);
    expect(result.current.state.settings?.roundPacingMs).toBe(2500);
  });

  it('a read started while a save is pending is dropped too (it may have been answered first)', async () => {
    const slowWrite = deferred<AppSettings>();
    const saved: AppSettings = { ...BASE, reduceMotion: 'on' };
    const readBeforeWriteLanded: AppSettings = { ...BASE, roundPacingMs: 9000 };
    const { result } = setup([BASE, readBeforeWriteLanded], [slowWrite.promise]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());

    let save!: Promise<boolean>;
    act(() => {
      save = result.current.actions.saveSettings({ reduceMotion: 'on' });
    });
    await act(() => result.current.actions.refreshSettings()); // answered while the save is pending
    expect(result.current.state.settings?.roundPacingMs).toBe(7000); // dropped: the save's answer decides
    slowWrite.resolve(saved);
    await act(async () => {
      await save;
    });
    expect(result.current.state.settings?.reduceMotion).toBe('on');
  });

  it('still loads the settings when a write was started before the first load and failed', async () => {
    const slowBoot = deferred<AppSettings>();
    const { result } = setup([slowBoot.promise], [new Error('fixture write failure')]);
    act(() => result.current.actions.setAnimationSpeed('fast')); // before anything is loaded
    await waitFor(() => expect(result.current.state.lastError?.scope).toBe('settings'));
    slowBoot.resolve(BASE);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());
    expect(result.current.state.settings?.roundPacingMs).toBe(7000);
  });

  it('never sends the read-only builtInPricingKeys', async () => {
    const { result, puts } = setup([BASE], [BASE]);
    await waitFor(() => expect(result.current.state.settings).not.toBeNull());
    await act(() => result.current.actions.saveSettings({ ...BASE, builtInPricingKeys: ['openai:fixture-model'] }));
    expect(puts[0]).not.toHaveProperty('builtInPricingKeys');
  });
});
