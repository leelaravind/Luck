/**
 * JSON API routes, exactly as documented in src/shared/contracts.ts ("HTTP API").
 * Handlers only parse/validate input and delegate to the GameService, which is authoritative
 * for game state. Errors thrown here or by the service are mapped by errors.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  GameError,
  type AppSettingsPatch,
  type BetInput,
  type CreateSessionRequest,
  type PlayerConfig,
} from '../../shared/contracts.js';
import type { AppConfig, GameService } from '../types.js';
import {
  IDEMPOTENCY_KEY_RE,
  controlBody,
  createSessionBody,
  exportQuery,
  idParams,
  isAiProviderKind,
  kindParams,
  limitQuery,
  manualRoundBody,
  providerBody,
  roundsQuery,
  settingsPatchBody,
} from './schemas.js';

/** Idempotency-Key is mandatory on the three "create something" POSTs. */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? undefined : raw?.trim();
  if (!key) {
    throw new GameError('validation_error', 'Missing Idempotency-Key header.');
  }
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new GameError('validation_error', 'Idempotency-Key must be 8–128 characters of letters, digits, "_" or "-".');
  }
  return key;
}

function providerKind(request: FastifyRequest) {
  const { kind } = kindParams.parse(request.params);
  if (!isAiProviderKind(kind)) throw new GameError('not_found', `Unknown AI provider "${kind}".`);
  return kind;
}

/** Optional { player } body for provider test/models; its kind must match the URL. */
function providerPlayer(request: FastifyRequest, kind: string): PlayerConfig | undefined {
  const player = providerBody.parse(request.body ?? undefined)?.player;
  if (player && player.kind !== kind) {
    throw new GameError('validation_error', `player.kind "${player.kind}" does not match provider "${kind}".`);
  }
  return player;
}

/** "luck-session 1.json" → "luck-session_1.json": only safe characters in Content-Disposition. */
function safeFilename(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || fallback;
}

export function registerApiRoutes(app: FastifyInstance, deps: { config: AppConfig; service: GameService }): void {
  const { config, service } = deps;

  app.get('/api/health', async () => ({ ok: true as const, version: config.version }));

  // ── providers ──
  app.get('/api/providers', async () => ({ providers: service.listProviders() }));

  app.post('/api/providers/:kind/test', async (request) => {
    const kind = providerKind(request);
    return service.testProvider(kind, providerPlayer(request, kind));
  });

  app.post('/api/providers/:kind/models', async (request) => {
    const kind = providerKind(request);
    return { models: await service.listModels(kind, providerPlayer(request, kind)) };
  });

  // ── settings ──
  app.get('/api/settings', async () => service.getSettings());

  app.put('/api/settings', async (request) => {
    const patch = settingsPatchBody.parse(request.body) as AppSettingsPatch;
    return service.updateSettings(patch);
  });

  // ── sessions ──
  app.get('/api/sessions', async () => ({ sessions: service.listSessions() }));

  app.post('/api/sessions', async (request) => {
    const key = requireIdempotencyKey(request);
    const body = createSessionBody.parse(request.body) as CreateSessionRequest;
    return service.createSession(body, key);
  });

  app.get('/api/sessions/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return service.getSnapshot(id);
  });

  app.post('/api/sessions/:id/rounds', async (request) => {
    const key = requireIdempotencyKey(request);
    const { id } = idParams.parse(request.params);
    const { bets } = manualRoundBody.parse(request.body);
    // Shape of each bet is validated by the service (validateBetSlip), never "repaired" here.
    return service.placeManualRound(id, bets as BetInput[], key);
  });

  app.post('/api/sessions/:id/control', async (request) => {
    const key = requireIdempotencyKey(request);
    const { id } = idParams.parse(request.params);
    const { action } = controlBody.parse(request.body);
    return service.control(id, action, key);
  });

  app.get('/api/sessions/:id/rounds', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit, beforeSeq } = roundsQuery.parse(request.query);
    const opts: { limit?: number; beforeSeq?: number } = {};
    if (limit !== undefined) opts.limit = limit;
    if (beforeSeq !== undefined) opts.beforeSeq = beforeSeq;
    return { rounds: service.listRounds(id, opts) };
  });

  app.get('/api/sessions/:id/decisions', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit } = limitQuery.parse(request.query);
    return { decisions: service.listDecisions(id, limit) };
  });

  app.get('/api/sessions/:id/usage', async (request) => {
    const { id } = idParams.parse(request.params);
    return service.getUsage(id);
  });

  app.get('/api/sessions/:id/logs', async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit } = limitQuery.parse(request.query);
    return { logs: service.listLogs(id, limit) };
  });

  app.get('/api/sessions/:id/export', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { format } = exportQuery.parse(request.query);
    const file = service.exportSession(id, format);
    const filename = safeFilename(file.filename, `luck-session-${id}.${format}`);
    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .type(file.contentType)
      .send(file.body);
  });

  // Unknown /api paths get a JSON 404 from the not-found handler registered in app.ts.
}
