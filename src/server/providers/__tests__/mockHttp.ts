/**
 * TEST FIXTURE ONLY (A7): a tiny node:http server on an ephemeral port (listen(0)) that plays the
 * role of a provider API. Nothing here talks to a real provider. Excluded from the server build
 * (tsconfig.server.json excludes __tests__).
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** Path + query, e.g. "/v1/messages". */
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Parsed JSON body, or undefined when the body is empty / not JSON. */
  json: any;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings are sent verbatim. */
  body?: unknown;
  /** Wait this long before sending anything (simulates a slow provider). */
  delayMs?: number;
  /** Send status + headers immediately, then wait this long before the body (stalled body). */
  stallBodyMs?: number;
}

export type MockHandler = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

export interface MockServer {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  setHandler(h: MockHandler): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startMockServer(initial: MockHandler): Promise<MockServer> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const rec: RecordedRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body, json };
      requests.push(rec);
      let r: MockResponse;
      try {
        r = await handler(rec);
      } catch (e) {
        r = { status: 500, body: { error: `mock handler threw: ${(e as Error).message}` } };
      }
      if (r.delayMs) await sleep(r.delayMs);
      if (res.destroyed) return;
      const bodyText = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      const headers: Record<string, string> = {
        'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json',
        ...(r.headers ?? {}),
      };
      res.writeHead(r.status ?? 200, headers);
      if (r.stallBodyMs) {
        res.flushHeaders();
        await sleep(r.stallBodyMs);
      }
      if (!res.destroyed) res.end(bodyText);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler(h) {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A base URL whose port had a listener a moment ago and now refuses connections. */
export async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A never-aborted signal for calls that do not test cancellation. */
export const neverAborted = (): AbortSignal => new AbortController().signal;
