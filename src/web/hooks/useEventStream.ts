/**
 * Server-Sent Events subscription for one session. The reported status mirrors the real EventSource:
 *   connecting    first connection attempt, not open yet
 *   live          stream open
 *   reconnecting  connection lost; the browser (or our backoff timer) is retrying
 *   offline       no stream (no session selected, EventSource unsupported, or the stream was closed
 *                 and the next retry is scheduled)
 * No latency or "ping" figure is invented; only facts the browser reports are surfaced.
 */
import { useEffect, useRef } from 'react';
import type { ServerEvent } from '../../shared/contracts';
import { parseServerEvent, SERVER_EVENT_TYPES } from '../api/events';
import type { ConnectionStatus } from '../state/luckReducer';

export interface EventStreamOptions {
  /** null = do not connect. */
  readonly url: string | null;
  readonly onEvent: (ev: ServerEvent) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Called when the stream (re)opens. `afterDrop` = events may have been missed; refetch. */
  readonly onOpen?: (afterDrop: boolean) => void;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const CONNECTING = 0;
const CLOSED = 2;

export function useEventStream({ url, onEvent, onStatus, onOpen }: EventStreamOptions): void {
  const handlers = useRef({ onEvent, onStatus, onOpen });
  handlers.current = { onEvent, onStatus, onOpen };

  useEffect(() => {
    const h = handlers.current;
    if (!url || typeof globalThis.EventSource !== 'function') {
      h.onStatus('offline');
      return;
    }
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let dropped = false;
    let disposed = false;

    const onFrame = (e: MessageEvent) => {
      const ev = parseServerEvent(String(e.data), e.type);
      if (ev) handlers.current.onEvent(ev);
    };

    const connect = () => {
      if (disposed) return;
      handlers.current.onStatus(dropped ? 'reconnecting' : 'connecting');
      const source = new EventSource(url);
      es = source;
      source.onopen = () => {
        failures = 0;
        handlers.current.onStatus('live');
        handlers.current.onOpen?.(dropped);
        dropped = false;
      };
      source.onerror = () => {
        dropped = true;
        if (source.readyState === CONNECTING) {
          // The browser retries on its own.
          handlers.current.onStatus('reconnecting');
          return;
        }
        if (source.readyState === CLOSED) {
          source.close();
          handlers.current.onStatus('offline');
          const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
          failures += 1;
          timer = setTimeout(connect, delay);
        }
      };
      source.addEventListener('message', onFrame);
      for (const t of SERVER_EVENT_TYPES) source.addEventListener(t, onFrame as EventListener);
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      handlers.current.onStatus('offline');
    };
  }, [url]);
}
