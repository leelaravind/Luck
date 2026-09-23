/**
 * Builds the Fastify application: security checks and headers, JSON-only body parsing with a
 * 64 KB limit, the documented /api routes, the SSE event stream, error mapping and — when a
 * production build exists — the static frontend on the same port.
 *
 * buildApp() does not listen; index.ts (or a test) decides where. It must only ever be
 * listened on a loopback address (config.host is validated by loadConfig).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig, GameService } from './types.js';
import { BODY_LIMIT_BYTES, registerErrorHandler } from './http/errors.js';
import { createConsoleLogger } from './http/logger.js';
import { registerApiRoutes } from './http/routes.js';
import { registerSecurity } from './http/security.js';
import { registerEventsRoute } from './http/sse.js';
import { registerStaticAndFallback } from './http/static.js';

export interface BuildAppDeps {
  config: AppConfig;
  service: GameService;
  /** true → print warnings/errors (redacted) to the console. Default: silent. */
  logger?: boolean;
  /** SSE heartbeat interval; tests shorten it. Default 15 s. */
  sseHeartbeatMs?: number;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { config, service } = deps;

  const app = Fastify({
    ...(deps.logger ? { loggerInstance: createConsoleLogger('warn') } : { logger: false }),
    bodyLimit: BODY_LIMIT_BYTES,
    // Never trust X-Forwarded-* headers: nothing legitimate sits in front of a loopback server.
    trustProxy: false,
    // Reject __proto__ / constructor.prototype keys in JSON bodies.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    // Close idle keep-alive sockets on shutdown so `app.close()` does not hang.
    forceCloseConnections: 'idle',
  });

  // JSON only: Fastify also accepts text/plain by default; drop it so any non-JSON body gets 415.
  app.removeContentTypeParser('text/plain');
  // Keep Fastify's hardened JSON parser (prototype-poisoning checks), but treat an empty
  // application/json body as "no body" so optional-body POSTs work from any fetch wrapper.
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(request, text, done);
  });

  // Hooks first, so they cover every route registered below (including static files and 404s).
  registerSecurity(app, config);
  registerErrorHandler(app);

  registerApiRoutes(app, { config, service });
  registerEventsRoute(app, { service, heartbeatMs: deps.sseHeartbeatMs });
  await registerStaticAndFallback(app, config.webDistDir);

  // Not calling app.ready() here: listen()/inject() do that, and callers may still add hooks.
  return app;
}
