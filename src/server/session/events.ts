/**
 * In-process event hub for session events (snapshot / round / decision / usage / log).
 * The HTTP layer turns these into an SSE stream; tests subscribe directly.
 * A throwing listener never breaks the game loop or other listeners.
 */
import type { ServerEvent } from '../../shared/contracts.js';

export type SessionListener = (ev: ServerEvent) => void;

export interface SessionEventHub {
  subscribe(sessionId: string, listener: SessionListener): () => void;
  emit(sessionId: string, ev: ServerEvent): void;
  listenerCount(sessionId: string): number;
}

export function createEventHub(onListenerError?: (err: unknown) => void): SessionEventHub {
  const listeners = new Map<string, Set<SessionListener>>();

  return {
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(sessionId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(sessionId);
      };
    },

    emit(sessionId, ev) {
      const set = listeners.get(sessionId);
      if (!set) return;
      // Copy so a listener that unsubscribes during dispatch does not skip others.
      for (const listener of [...set]) {
        try {
          listener(ev);
        } catch (err) {
          onListenerError?.(err);
        }
      }
    },

    listenerCount(sessionId) {
      return listeners.get(sessionId)?.size ?? 0;
    },
  };
}
