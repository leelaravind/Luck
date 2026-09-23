/**
 * SSE /api/events over a real loopback socket (ephemeral port 0) with a FIXTURE GameService.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RoundRecord } from '../../shared/contracts.js';
import { buildApp } from '../app.js';
import { FIXTURE_SESSION_ID, createFakeService, testConfig } from './__tests__/fake-service.js';
import { formatSseEvent } from './sse.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** Reads an SSE response and resolves once `predicate` holds for the parsed events so far. */
function collectEvents(res: IncomingMessage, predicate: (events: { event: string; data: any }[]) => boolean) {
  return new Promise<{ event: string; data: any }[]>((resolve, reject) => {
    let buffer = '';
    const events: { event: string; data: any }[] = [];
    const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(events.map((e) => e.event))}`)), 5000);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.+)$/m.exec(block)?.[1];
        events.push({ event, data: data ? JSON.parse(data) : null });
      }
      if (predicate(events)) {
        clearTimeout(timer);
        resolve(events);
      }
    });
    res.on('error', reject);
  });
}

async function listen(heartbeatMs = 60_000) {
  const service = createFakeService();
  // Config says 3717, but we listen on an ephemeral port: the Host check must accept the bound port.
  app = await buildApp({ config: testConfig(), service, sseHeartbeatMs: heartbeatMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { service, port };
}

function open(port: number, path: string) {
  return new Promise<{ res: IncomingMessage; destroy: () => void }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { accept: 'text/event-stream' } }, (res) =>
      resolve({ res, destroy: () => req.destroy() }),
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/events', () => {
  it('formats events as "event: <type>\\ndata: <json>\\n\\n"', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(formatSseEvent({ type: 'heartbeat', at })).toBe(`event: heartbeat\ndata: {"type":"heartbeat","at":"${at}"}\n\n`);
  });

  it('streams a snapshot first, then service events and heartbeats; unsubscribes on close', async () => {
    const { service, port } = await listen(50);
    const { res, destroy } = await open(port, `/api/events?sessionId=${FIXTURE_SESSION_ID}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);

    const round = { id: 'r1', sessionId: FIXTURE_SESSION_ID, seq: 1, status: 'settled' } as unknown as RoundRecord;
    let emitted = false;
    const events = await collectEvents(res, (evs) => {
      if (!emitted && evs.length >= 1) {
        emitted = true;
        service.emit(FIXTURE_SESSION_ID, { type: 'round', round });
      }
      return evs.some((e) => e.event === 'round') && evs.some((e) => e.event === 'heartbeat');
    });

    expect(events[0]!.event).toBe('snapshot');
    expect(events[0]!.data.type).toBe('snapshot');
    expect(events[0]!.data.snapshot.session.id).toBe(FIXTURE_SESSION_ID);
    expect(events.find((e) => e.event === 'round')!.data).toEqual({ type: 'round', round });
    expect(service.subscriberCount(FIXTURE_SESSION_ID)).toBe(1);

    destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(service.subscriberCount(FIXTURE_SESSION_ID)).toBe(0);
    expect(service.calls).toContainEqual(['unsubscribe', FIXTURE_SESSION_ID]);
  });

  it('returns a JSON 404 (not a stream) for an unknown session', async () => {
    const { port, service } = await listen();
    const { res } = await open(port, '/api/events?sessionId=nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    res.resume();
    expect(service.subscriberCount('nope')).toBe(0);
  });

  it('requires sessionId', async () => {
    const { port } = await listen();
    const { res } = await open(port, '/api/events');
    expect(res.statusCode).toBe(400);
    res.resume();
  });

  it('server close ends open streams instead of hanging', async () => {
    const { port } = await listen();
    const { res } = await open(port, `/api/events?sessionId=${FIXTURE_SESSION_ID}`);
    const ended = new Promise<void>((resolve) => res.on('close', () => resolve()));
    res.resume();
    await app!.close();
    app = null;
    await ended;
  });
});
