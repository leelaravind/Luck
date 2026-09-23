/**
 * Browser-facing request security for the local API.
 *
 * Luck listens only on loopback, but any web page the user visits can still try to talk to
 * http://127.0.0.1:3717. These checks stop that:
 *  - Host allow-list on EVERY request (DNS-rebinding protection: a rebound evil.example
 *    resolves to 127.0.0.1 but still sends "Host: evil.example").
 *  - On /api routes, and on every non-GET/HEAD request whatever its path:
 *      · an Origin header, when present, must be one of our own origins;
 *      · Sec-Fetch-Site "cross-site" / "same-site" is refused;
 *      · non-GET/HEAD requests must carry "X-Luck-Client: 1". A custom header forces a CORS
 *        preflight, and because we NEVER send Access-Control-Allow-* headers the preflight
 *        fails, so cross-origin pages cannot make state-changing requests.
 *  - Security headers (CSP etc.) on every response.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { GameError } from '../../shared/contracts.js';
import type { AppConfig } from '../types.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** Header every state-changing request must send. */
export const CLIENT_HEADER = 'x-luck-client';
export const CLIENT_HEADER_VALUE = '1';

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

export interface SecurityPolicy {
  /** Lower-case "host:port" values accepted in the Host header. */
  allowedHosts: Set<string>;
  /** Exact origins accepted in the Origin header. */
  allowedOrigins: Set<string>;
}

/** Hosts/origins for our own port(s), plus the Vite dev server when dev mode is enabled. */
export function buildPolicy(config: Pick<AppConfig, 'port' | 'devOrigins'>, ports: number[] = []): SecurityPolicy {
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const p of new Set([config.port, ...ports])) {
    if (!Number.isInteger(p) || p <= 0) continue;
    for (const name of LOOPBACK_NAMES) {
      allowedHosts.add(`${name}:${p}`);
      allowedOrigins.add(`http://${name}:${p}`);
    }
  }
  for (const origin of config.devOrigins) {
    try {
      const u = new URL(origin);
      allowedOrigins.add(u.origin);
      allowedHosts.add(u.host.toLowerCase());
    } catch {
      // loadConfig only produces valid origins; ignore anything else
    }
  }
  return { allowedHosts, allowedOrigins };
}

/** Path without the query string. */
export function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * True for /api and /api/…, also when the path is percent-encoded or differently cased
 * (so "/%61pi/sessions" cannot slip past the API checks).
 */
export function isApiPath(url: string): boolean {
  let p = pathOf(url);
  try {
    p = decodeURIComponent(p);
  } catch {
    // malformed escapes: judge the raw path
  }
  p = p.toLowerCase();
  return p === '/api' || p.startsWith('/api/');
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

export type SecurityVerdict = { ok: true } | { ok: false; reason: string };

export interface RequestLike {
  method: string;
  url: string;
  /** Route pattern Fastify matched (e.g. "/api/sessions/:id"), if any. */
  routeUrl?: string;
  headers: IncomingHttpHeaders;
}

/** Pure decision function: is this request allowed through? */
export function checkRequest(req: RequestLike, policy: SecurityPolicy): SecurityVerdict {
  const host = single(req.headers.host)?.trim().toLowerCase();
  if (!host || !policy.allowedHosts.has(host)) {
    return { ok: false, reason: 'Unexpected Host header. Open Luck at http://127.0.0.1 on its configured port.' };
  }

  const method = req.method.toUpperCase();
  const readOnly = method === 'GET' || method === 'HEAD';
  const api = isApiPath(req.url) || (req.routeUrl !== undefined && isApiPath(req.routeUrl));
  if (readOnly && !api) return { ok: true }; // static files / SPA pages: Host check only

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const o = single(origin);
    if (o === undefined || !policy.allowedOrigins.has(o)) {
      return { ok: false, reason: 'Cross-origin requests are not allowed.' };
    }
  }

  const site = single(req.headers['sec-fetch-site'])?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') {
    return { ok: false, reason: 'Cross-site requests are not allowed.' };
  }

  if (!readOnly && single(req.headers[CLIENT_HEADER])?.trim() !== CLIENT_HEADER_VALUE) {
    return { ok: false, reason: 'Missing "X-Luck-Client: 1" header.' };
  }
  return { ok: true };
}

/**
 * Install the security headers and checks on an app. Must run before routes/plugins are
 * registered so the hooks cover all of them (including static files and 404s).
 */
export function registerSecurity(app: FastifyInstance, config: Pick<AppConfig, 'port' | 'devOrigins'>): void {
  const basePolicy = buildPolicy(config);
  let boundPolicy: { port: number; policy: SecurityPolicy } | null = null;

  /** Also accept the port we are actually bound to (differs from config.port when listening on port 0). */
  const currentPolicy = (): SecurityPolicy => {
    const addr = app.server.address() as AddressInfo | string | null;
    const bound = addr && typeof addr === 'object' ? addr.port : null;
    if (!bound || bound === config.port) return basePolicy;
    if (boundPolicy?.port !== bound) boundPolicy = { port: bound, policy: buildPolicy(config, [bound]) };
    return boundPolicy.policy;
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (isApiPath(request.url)) reply.header('Cache-Control', 'no-store');

    const verdict = checkRequest(
      { method: request.method, url: request.url, routeUrl: request.routeOptions.url, headers: request.headers },
      currentPolicy(),
    );
    if (!verdict.ok) {
      request.log.warn(`Blocked ${request.method} ${pathOf(request.url)}: ${verdict.reason}`);
      throw new GameError('forbidden', verdict.reason);
    }
  });

  // Defence in depth: this server never grants CORS, whatever a plugin might try to add.
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const name of Object.keys(reply.getHeaders())) {
      if (name.toLowerCase().startsWith('access-control-')) reply.removeHeader(name);
    }
    return payload;
  });
}
