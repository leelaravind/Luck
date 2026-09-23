/**
 * Parsing for the /api/events text/event-stream. The server may send each ServerEvent either as an
 * unnamed SSE message whose JSON carries `type`, or as a named event (`event: round`). Both are accepted;
 * a browser only delivers a given frame to one of the two listeners, so nothing is handled twice.
 */
import type { ServerEvent } from '../../shared/contracts';

export const SERVER_EVENT_TYPES = ['snapshot', 'round', 'decision', 'usage', 'log', 'heartbeat'] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

function isEventType(t: unknown): t is ServerEventType {
  return typeof t === 'string' && (SERVER_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * Parse one SSE frame. `eventName` is the SSE `event:` field ('message' when absent).
 * Returns null for anything that is not a recognisable ServerEvent (ignored, never guessed).
 */
export function parseServerEvent(data: string, eventName = 'message'): ServerEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = isEventType(obj.type) ? obj.type : isEventType(eventName) ? eventName : null;
  if (!type) return null;

  // A named event may carry the payload bare (e.g. `event: round` + RoundRecord JSON) or wrapped.
  switch (type) {
    case 'snapshot':
      return obj.snapshot && typeof obj.snapshot === 'object'
        ? ({ type, snapshot: obj.snapshot } as ServerEvent)
        : obj.session
          ? ({ type, snapshot: obj } as unknown as ServerEvent)
          : null;
    case 'round':
      return obj.round && typeof obj.round === 'object'
        ? ({ type, round: obj.round } as ServerEvent)
        : typeof obj.seq === 'number'
          ? ({ type, round: obj } as unknown as ServerEvent)
          : null;
    case 'decision':
      return obj.decision && typeof obj.decision === 'object'
        ? ({ type, decision: obj.decision } as ServerEvent)
        : typeof obj.roundNumber === 'number'
          ? ({ type, decision: obj } as unknown as ServerEvent)
          : null;
    case 'usage':
      return obj.usage && typeof obj.usage === 'object'
        ? ({ type, usage: obj.usage } as ServerEvent)
        : typeof obj.decisionId === 'string'
          ? ({ type, usage: obj } as unknown as ServerEvent)
          : null;
    case 'log':
      return obj.log && typeof obj.log === 'object'
        ? ({ type, log: obj.log } as ServerEvent)
        : typeof obj.message === 'string' && typeof obj.id === 'number'
          ? ({ type, log: obj } as unknown as ServerEvent)
          : null;
    case 'heartbeat':
      return { type, at: typeof obj.at === 'string' ? obj.at : new Date().toISOString() };
  }
}
