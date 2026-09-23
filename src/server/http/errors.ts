/**
 * Maps anything thrown by a route, hook or the body parser to an ApiErrorBody response.
 *   GameError            → HTTP_STATUS_FOR[code], its (redacted) message and details
 *   ZodError             → 400 validation_error with the list of issues
 *   Fastify 4xx errors   → their status (413 body too large, 415 not JSON, 400 bad JSON…), safe message
 *   anything else        → 500 internal with a generic message; the redacted stack goes to the server log only
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { GameError, HTTP_STATUS_FOR, type ApiErrorBody, type ApiErrorCode } from '../../shared/contracts.js';
import { redact } from '../redact.js';

export const BODY_LIMIT_BYTES = 64 * 1024;

export function apiError(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

/** Redact every string inside a JSON-compatible value; drops details that cannot be serialised. */
function redactDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    return JSON.parse(redact(JSON.stringify(details))) as unknown;
  } catch {
    return undefined;
  }
}

function isGameError(err: unknown): err is GameError {
  if (err instanceof GameError) return true;
  // Duck-typed as well, in case a second copy of the contracts module is ever loaded.
  if (!(err instanceof Error) || err.name !== 'GameError') return false;
  const code = (err as unknown as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(HTTP_STATUS_FOR, code);
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === 'ZodError' && Array.isArray((err as ZodError).issues));
}

/** Safe, fixed messages for Fastify's own request errors (their raw messages can echo input). */
const FASTIFY_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: `Request body is too large (limit ${BODY_LIMIT_BYTES / 1024} KB).`,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Only application/json request bodies are accepted.',
  FST_ERR_CTP_INVALID_TYPE: 'Content-Type must be application/json.',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'Request body must not be empty when Content-Type is application/json.',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Content-Length does not match the request body.',
  FST_ERR_CTP_INVALID_JSON_BODY: 'Request body is not valid JSON.',
  FST_ERR_CTP_INVALID_CHARSET: 'Request body must be UTF-8 JSON.',
};

export interface MappedError {
  status: number;
  body: ApiErrorBody;
  /** Unexpected errors are logged with their (redacted) stack. */
  unexpected: boolean;
}

export function mapError(err: unknown): MappedError {
  if (isGameError(err)) {
    return {
      status: HTTP_STATUS_FOR[err.code],
      body: apiError(err.code, redact(err.message), redactDetails(err.details)),
      unexpected: false,
    };
  }
  if (isZodError(err)) {
    const issues = err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: redact(i.message) }));
    const first = issues[0];
    const message = first ? `Invalid request: ${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid request.';
    return { status: 400, body: apiError('validation_error', message, { issues }), unexpected: false };
  }
  const fe = err as Partial<FastifyError> | undefined;
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    const code: ApiErrorCode = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'validation_error';
    const message =
      (fe?.code && FASTIFY_MESSAGES[fe.code]) ||
      (err instanceof SyntaxError ? 'Request body is not valid JSON.' : status === 404 ? 'Not found.' : 'Bad request.');
    return { status, body: apiError(code, message), unexpected: false };
  }
  return { status: 500, body: apiError('internal', 'Internal server error.'), unexpected: true };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) {
      // Full details stay on the server; the logger redacts them before printing.
      request.log.error({ err }, `Unhandled error on ${request.method} ${request.url.split('?')[0]}`);
    }
    return reply.code(mapped.status).type('application/json; charset=utf-8').send(mapped.body);
  });
}
