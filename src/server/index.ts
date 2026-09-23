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
 *
 * Exit codes: any startup failure (bad configuration, port already in use, …) exits with 1.
 *
 * `--check-port` (used by `npm run dev` before `tsx watch` starts): only loads the configuration
 * and checks that LUCK_PORT is free, then exits 0 (free) or 1 (busy / bad config). `tsx watch`
 * keeps waiting for file changes when the server exits, so without this check a busy port would
 * leave the web UI running against whatever other program owns that port; with it, the dev
 * runner (concurrently -k) sees the failure and stops the web UI too.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
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

/** True when started by the development runner (`npm run dev`), not with --production. */
function isDevRunner(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** Steps 2–3: .env, --production, loadConfig. Prints a readable message and returns null on bad values. */
function loadEnvironment(): AppConfig | null {
  const repoRoot = findRepoRoot();
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // `npm run serve` passes --production (instead of a shell-specific NODE_ENV=production prefix).
  if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

  try {
    return loadConfig(process.env);
  } catch (err) {
    logError(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    logError('Fix the value in .env (see .env.example and docs/configuration.md), then start again.');
    return null;
  }
}

/** Resolves when host:port could be bound (and was released again), or with the bind error. */
function probePort(host: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(null)));
  });
}

/** `--check-port`: exit 0 when LUCK_PORT is free, 1 when it is busy or the configuration is invalid. */
async function checkPortOnly(): Promise<never> {
  const config = loadEnvironment();
  if (!config) process.exit(1);
  const err = await probePort(config.host, config.port);
  if (!err) process.exit(0);
  if (err.code === 'EADDRINUSE') printPortInUse(config);
  else logError(`Cannot listen on ${config.host}:${config.port}: ${describe(err)}`);
  logError('The server was not started, so the web UI is being stopped too.');
  process.exit(1);
}

async function main(): Promise<void> {
  installSqliteWarningFilter();

  const config = loadEnvironment();
  if (!config) process.exit(1);

  mkdirSync(config.dataDir, { recursive: true });

  // Loaded only now so the SQLite warning filter above is already in place.
  const { openRepository } = await import('./db/sqlite.js');
  const { createGameService } = await import('./session/service.js');

  // The version comes from package.json (config), so exports never say "unknown", even when
  // the server is started directly with node instead of through npm.
  const repo = openRepository(config.dbPath, { appVersion: config.version });
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
    // Exit now with a non-zero code (instead of only setting exitCode), so nothing that is still
    // pending can keep a half-started server alive and the caller always sees the failure.
    process.exit(1);
  }

  const url = browserUrl(config.host, config.port);
  const webUiUrl = config.devOrigins[0];
  if (config.isDev && isDevRunner() && webUiUrl) {
    // Development: the UI is served by Vite on LUCK_WEB_PORT; this port is only the API.
    log(`Luck API server is running at ${url} (development mode).`);
    log(`Open ${webUiUrl} in your browser (the web UI with hot reload, started by "npm run dev").`);
    if (hasWebBuild(config.webDistDir)) {
      log(`Note: ${url} also serves an OLDER production build from dist/web. Use ${webUiUrl} while developing.`);
    }
  } else if (hasWebBuild(config.webDistDir)) {
    log(`Luck is running at ${url}`);
    log(`Open ${url} in your browser.`);
  } else {
    log(`Luck API server is running at ${url}`);
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

const entry = process.argv.includes('--check-port') ? checkPortOnly() : main();
entry.catch((err: unknown) => {
  logError(`Luck failed to start: ${describe(err)}`);
  process.exit(1);
});
