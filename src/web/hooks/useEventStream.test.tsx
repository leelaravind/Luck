// @vitest-environment jsdom
// Tests for the SSE hook's status reporting with a fake EventSource (no server).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../shared/contracts';
import type { ConnectionStatus } from '../state/luckReducer';
import { useEventStream } from './useEventStream';

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  fire(t: string, data: unknown) {
    for (const fn of this.listeners[t] ?? []) fn(new MessageEvent(t, { data: JSON.stringify(data) }));
  }
}

beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useEventStream', () => {
  it('reports real EventSource states, parses both message styles and reconnects after CLOSED', () => {
    const statuses: ConnectionStatus[] = [];
    const events: ServerEvent[] = [];
    const opens: boolean[] = [];
    const { unmount } = renderHook(() =>
      useEventStream({
        url: '/api/events?sessionId=s1',
        onEvent: (e) => events.push(e),
        onStatus: (s) => statuses.push(s),
        onOpen: (d) => opens.push(d),
      }),
    );
    const es = FakeES.all[0]!;
    expect(statuses.at(-1)).toBe('connecting');

    act(() => {
      es.readyState = 1;
      es.onopen?.();
    });
    expect(statuses.at(-1)).toBe('live');
    expect(opens).toEqual([false]);

    es.fire('message', { type: 'heartbeat', at: 'T1' });
    es.fire('round', { id: 'r1', seq: 1 });
    expect(events.map((e) => e.type)).toEqual(['heartbeat', 'round']);

    act(() => {
      es.readyState = 0; // browser retrying
      es.onerror?.();
    });
    expect(statuses.at(-1)).toBe('reconnecting');

    act(() => {
      es.readyState = 2; // browser gave up
      es.onerror?.();
    });
    expect(statuses.at(-1)).toBe('offline');
    expect(es.closed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeES.all).toHaveLength(2);
    expect(statuses.at(-1)).toBe('reconnecting');
    act(() => {
      FakeES.all[1]!.readyState = 1;
      FakeES.all[1]!.onopen?.();
    });
    expect(statuses.at(-1)).toBe('live');
    expect(opens).toEqual([false, true]); // afterDrop → caller refetches

    unmount();
    expect(FakeES.all[1]!.closed).toBe(true);
    expect(statuses.at(-1)).toBe('offline');
  });

  it('does not connect without a URL', () => {
    const statuses: ConnectionStatus[] = [];
    renderHook(() => useEventStream({ url: null, onEvent: () => {}, onStatus: (s) => statuses.push(s) }));
    expect(FakeES.all).toHaveLength(0);
    expect(statuses).toEqual(['offline']);
  });
});
