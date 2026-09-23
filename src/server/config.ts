/**
 * Server configuration, read once at startup from environment variables (.env is loaded by
 * index.ts before this runs). Every value is validated here so the rest of the server can
 * trust AppConfig. Secrets stay in AppConfig on the server and are registered with the
 * redactor; they are never sent to the browser.
 *
 * See docs/configuration.md for the full variable reference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types.js';
import { registerSecret } from './redact.js';

const PACKAGE_NAME = 'luck-ai-roulette-lab';

/** The only hosts the server may bind to. There is deliberately no override. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

export const DEFAULT_PORT = 3717;
export const DEFAULT_WEB_PORT = 5717;

let cachedRepoRoot: string | null = null;

/**
 * Absolute path of the repository root (the folder holding this project's package.json).
 * Found by walking up from this file, so it is the same whether the server runs from
 * src/server (tsx) or dist/server/server (compiled), and independent of the current directory.
 */
export function findRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown };
        if (pkg.name === PACKAGE_NAME) {
          cachedRepoRoot = dir;
          return dir;
        }
      } catch {
        // unreadable package.json on the way up: keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find the Luck project folder (package.json named "${PACKAGE_NAME}") above ${fileURLToPath(import.meta.url)}.`);
    }
    dir = parent;
  }
}

function readVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

// ───────────────────────────── value parsers ─────────────────────────────

/** Trimmed value with one pair of surrounding quotes removed; empty → undefined. */
function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  let v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v === '' ? undefined : v;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = str(env, name);
  if (v === undefined) return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
    throw new Error(`${name} must be a whole number between 1 and 65535 (got "${v}").`);
  }
  return Number(v);
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = str(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be "true" or "false" (got "${v}").`);
}

/**
 * http(s) URL with trailing slashes removed. Credentials inside the URL are refused because
 * base URLs are shown in the UI; keys belong in the *_API_KEY variables.
 */
function httpUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string;
function httpUrl(env: NodeJS.ProcessEnv, name: string, fallback?: undefined): string | undefined;
function httpUrl(env: NodeJS.ProcessEnv, name: string, fallback?: string): string | undefined {
  const v = str(env, name) ?? fallback;
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`${name} must be a full http:// or https:// URL (got "${v}").`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http:// or https:// (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain a username or password. Put API keys in the matching *_API_KEY variable instead.`);
  }
  return v.replace(/\/+$/, '');
}

function normaliseHost(value: string | undefined): string {
  const v = (value ?? '127.0.0.1').toLowerCase();
  const host = v === '[::1]' ? '::1' : v;
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `LUCK_HOST must be a loopback address (127.0.0.1, ::1 or localhost); got "${value}". ` +
        'Luck only listens on this computer and cannot be exposed to a network.',
    );
  }
  return host;
}

// ───────────────────────────── loadConfig ─────────────────────────────

/** Read and validate configuration. Throws an Error with a user-readable message on bad values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = findRepoRoot();

  const host = normaliseHost(str(env, 'LUCK_HOST'));
  const serverPort = port(env, 'LUCK_PORT', DEFAULT_PORT);
  const webPort = port(env, 'LUCK_WEB_PORT', DEFAULT_WEB_PORT);

  // Dev mode allows the Vite dev server origin (http://127.0.0.1:<LUCK_WEB_PORT>) to call the API.
  const isDev = env.NODE_ENV !== 'production' || str(env, 'LUCK_DEV') === '1';
  if (isDev && webPort === serverPort) {
    throw new Error(`LUCK_WEB_PORT and LUCK_PORT must be different in development (both are ${serverPort}).`);
  }
  const devOrigins = isDev ? [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`] : [];

  // Relative data dirs are resolved against the project folder, never the current directory.
  const dataDir = resolve(repoRoot, str(env, 'LUCK_DATA_DIR') ?? 'data');

  const layaCheckpoint = str(env, 'LAYA_CHECKPOINT') ?? 'english';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(layaCheckpoint)) {
    throw new Error(`LAYA_CHECKPOINT may only contain letters, digits, ".", "_" and "-" (got "${layaCheckpoint}").`);
  }

  const anthropicKey = str(env, 'ANTHROPIC_API_KEY');
  const openaiKey = str(env, 'OPENAI_API_KEY');
  const layaKey = str(env, 'LAYA_API_KEY');
  registerSecret(anthropicKey);
  registerSecret(openaiKey);
  registerSecret(layaKey);

  return {
    version: readVersion(repoRoot),
    host,
    port: serverPort,
    devOrigins,
    isDev,
    dataDir,
    dbPath: join(dataDir, 'luck.db'),
    webDistDir: join(repoRoot, 'dist', 'web'),
    providers: {
      ollama: {
        baseUrl: httpUrl(env, 'OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
        model: str(env, 'OLLAMA_MODEL'),
      },
      anthropic: {
        apiKey: anthropicKey,
        baseUrl: httpUrl(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        model: str(env, 'ANTHROPIC_MODEL'),
      },
      openai: {
        apiKey: openaiKey,
        // No default on purpose: the user must say which OpenAI-compatible endpoint to call.
        baseUrl: httpUrl(env, 'OPENAI_BASE_URL'),
        model: str(env, 'OPENAI_MODEL'),
      },
      claudeCli: {
        path: str(env, 'CLAUDE_CLI_PATH'),
        enabled: bool(env, 'CLAUDE_CLI_ENABLED', true),
        model: str(env, 'CLAUDE_CLI_MODEL'),
        useSubscriptionAuth: bool(env, 'CLAUDE_CLI_USE_SUBSCRIPTION', true),
      },
      laya: {
        baseUrl: httpUrl(env, 'LAYA_BASE_URL', 'http://127.0.0.1:8000'),
        apiKey: layaKey,
        checkpoint: layaCheckpoint,
      },
    },
  };
}
