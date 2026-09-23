/**
 * GET /api/events?sessionId=… — Server-Sent Events stream of ServerEvent for one session.
 *
 * Wire format per event (data is the whole ServerEvent as one line of JSON, including "type"):
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 * A 'snapshot' event is sent immediately, then every event the service publishes, plus a
 * 'heartbeat' event every 15 s so proxies and the browser keep the connection open.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '../../shared/contracts.js';
import type { GameService } from '../types.js';
import { eventsQuery } from './schemas.js';
import { SECURITY_HEADERS } from './security.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;

export function formatSseEvent(ev: ServerEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export function registerEventsRoute(app: FastifyInstance, deps: { service: GameService; heartbeatMs?: number }): void {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  /** Open streams, ended when the server closes so shutdown is not held up by idle browsers. */
  const open = new Set<ServerResponse>();

  app.addHook('preClose', async () => {
    for (const res of open) res.end();
    open.clear();
  });

  app.get('/api/events', { exposeHeadRoute: false }, async (request, reply) => {
    const { sessionId } = eventsQuery.parse(request.query);
    // Throws GameError('not_found') for an unknown session → normal JSON error, before streaming starts.
    const snapshot = deps.service.getSnapshot(sessionId);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    open.add(res);

    const send = (ev: ServerEvent) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(formatSseEvent(ev));
    };

    // getSnapshot and subscribe run in the same tick, so no event can fall between them.
    send({ type: 'snapshot', snapshot });
    let unsubscribe: (() => void) | null = deps.service.subscribe(sessionId, send);
    const heartbeat = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), heartbeatMs);
    heartbeat.unref();

    res.on('close', () => {
      clearInterval(heartbeat);
      open.delete(res);
      if (unsubscribe) {
        const u = unsubscribe;
        unsubscribe = null;
        u();
      }
    });
  });
}
