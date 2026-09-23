/**
 * Small human-readable logger handed to Fastify (instead of raw pino JSON lines), so the terminal
 * stays readable for beginners. Every line passes through redact(), and only warnings and errors
 * are printed: per-request "incoming request"/"request completed" info lines are dropped.
 */
import type { FastifyBaseLogger } from 'fastify';
import { redact } from '../redact.js';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const ORDER: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Turns pino-style arguments ((obj, msg) | (msg) | (err)) into one redacted line. */
function formatLine(level: Level, args: unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg === undefined) continue;
    if (typeof arg === 'string') parts.push(arg);
    else if (arg instanceof Error) parts.push(describeError(arg));
    else if (arg && typeof arg === 'object') {
      const { err, error, ...rest } = arg as Record<string, unknown>;
      const e = err ?? error;
      if (Object.keys(rest).length > 0) {
        try {
          parts.push(JSON.stringify(rest));
        } catch {
          /* unserialisable context: skip it */
        }
      }
      if (e !== undefined) parts.push(describeError(e));
    } else parts.push(String(arg));
  }
  return redact(`[luck] ${level}: ${parts.join(' ')}`);
}

export function createConsoleLogger(minLevel: Level = 'warn'): FastifyBaseLogger {
  const make = (level: Level) =>
    ORDER[level] < ORDER[minLevel]
      ? () => undefined
      : (...args: unknown[]) => {
          const line = formatLine(level, args);
          if (ORDER[level] >= ORDER.error) console.error(line);
          else console.log(line);
        };
  const logger = {
    level: minLevel,
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    silent: () => undefined,
    child: () => logger,
  };
  // The pino LogFn overloads are wider than this implementation needs; the runtime shape matches.
  return logger as unknown as FastifyBaseLogger;
}
