/**
 * Server entry point (`npm run dev` runs it with tsx; `npm start` / `npm run serve` run the
 * compiled dist/server/server/index.js with --production).
 *
 * Startup order:
 *   1. filter out ONLY node:sqlite's ExperimentalWarning (see below)
 *   2. load <repo>/.env if it exists (real environment variables win over .env)
 *   3. loadConfig() — refuses non-loopback hosts and bad values with a readable message
 *   4. open the SQLite repository, create the game service, run crash recovery
 *   5. build the HTTP app and listen on 127.0.0.1 (never kills anything if the port is busy)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { findRepoRoot, loadConfig } from './config.js';
import { hasWebBuild } from './http/static.js';
import { redact } from './redact.js';
import type { AppConfig } from './types.js';

/**
 * Warning policy (documented in docs/configuration.md): node:sqlite prints
 * "ExperimentalWarning: SQLite is an experimental feature…" on first load. We wrap
 * process.emitWarning and drop exactly that warning; every other warning (including other
 * ExperimentalWarnings and deprecations) is still printed. This is why the sqlite-backed
 * modules are imported dynamically below, after the filter is installed.
 */
function installSqliteWarningFilter(): void {
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const opt = rest[0];
    const type =
      typeof opt === 'string'
        ? opt
        : ((opt as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined));
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /\bSQLite\b/.test(message ?? '')) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
}

function log(message: string): void {
  console.log(`[luck] ${redact(message)}`);
}

function logError(message: string): void {
  console.error(`[luck] ${redact(message)}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function browserUrl(host: string, port: number): string {
  if (host === '::1') return `http://[::1]:${port}`;
  if (host === 'localhost') return `http://localhost:${port}`;
  return `http://127.0.0.1:${port}`;
}

function printPortInUse(config: AppConfig): void {
  logError(`Port ${config.port} on ${config.host} is already in use — Luck may already be running in another window.`);
  logError('Luck never stops other programs. Either close whatever is using that port, or choose a free port:');
  logError(`  open .env and set LUCK_PORT to another number (for example LUCK_PORT=${config.port + 10}), then start again.`);
}

async function main(): Promise<void> {
  installSqliteWarningFilter();

  const repoRoot = findRepoRoot();
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // `npm run serve` passes --production (instead of a shell-specific NODE_ENV=production prefix).
  if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    logError(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    logError('Fix the value in .env (see .env.example and docs/configuration.md), then start again.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(config.dataDir, { recursive: true });

  // Loaded only now so the SQLite warning filter above is already in place.
  const { openRepository } = await import('./db/sqlite.js');
  const { createGameService } = await import('./session/service.js');

  const repo = openRepository(config.dbPath);
  const service = createGameService({ config, repo });

  const recovered = service.recover();
  if (recovered.settledRounds || recovered.pausedSessions || recovered.interruptedDecisions) {
    log(
      `Recovered after restart: settled ${recovered.settledRounds} unfinished round(s), paused ` +
        `${recovered.pausedSessions} session(s), marked ${recovered.interruptedDecisions} decision(s) interrupted. ` +
        'Nothing resumes on its own — press Start to continue a session.',
    );
  }

  const app = await buildApp({ config, service, logger: true });

  let closing = false;
  const closeAll = async (): Promise<void> => {
    try {
      await app.close();
    } catch (err) {
      logError(`Error while closing the HTTP server: ${describe(err)}`);
    }
    try {
      await service.shutdown();
    } catch (err) {
      logError(`Error while stopping sessions: ${describe(err)}`);
    }
    try {
      repo.close();
    } catch (err) {
      logError(`Error while closing the database: ${describe(err)}`);
    }
  };

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') printPortInUse(config);
    else logError(`Could not start the server: ${describe(err)}`);
    await closeAll();
    process.exitCode = 1;
    return;
  }

  const url = browserUrl(config.host, config.port);
  log(`Luck is running at ${url}`);
  if (hasWebBuild(config.webDistDir)) {
    log(`Open ${url} in your browser.`);
  } else if (config.isDev && config.devOrigins[0]) {
    log(`This is the API server. Open the web UI at ${config.devOrigins[0]} (started by "npm run dev").`);
  } else {
    log('No built frontend found in dist/web. Run "npm start" (it builds first) or "npm run build".');
  }
  log(`Data folder: ${config.dataDir}`);

  const onSignal = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal} received — stopping sessions and closing the database…`);
    // Last resort if something hangs: exit anyway after 10 s.
    const force = setTimeout(() => {
      logError('Shutdown took too long; exiting.');
      process.exit(1);
    }, 10_000);
    force.unref();
    void closeAll().then(() => {
      clearTimeout(force);
      log('Stopped.');
      process.exit(0);
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  if (process.platform === 'win32') process.once('SIGBREAK', () => onSignal('SIGBREAK'));
}

main().catch((err: unknown) => {
  logError(`Luck failed to start: ${describe(err)}`);
  process.exit(1);
});
