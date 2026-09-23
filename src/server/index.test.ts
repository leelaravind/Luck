/**
 * Startup message of the server entry point (src/server/index.ts), checked by starting the REAL entry point as a
 * child process (`node --import tsx src/server/index.ts`) on ephemeral ports with a throw-away data folder.
 *
 * Regression (final audit): a direct start without --production said "Open http://127.0.0.1:<LUCK_WEB_PORT>"
 * (the Vite dev server) although nothing was listening there, because "started by npm run dev" was guessed from
 * NODE_ENV. Now only the `dev:server` script's explicit `--dev-runner` argument points to the Vite URL.
 * Whether dist/web holds a build depends on the checkout, so each case accepts both variants of the message.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = path.join(REPO_ROOT, 'tmp', `startup-banner-${randomUUID()}`);
const START_TIMEOUT_MS = 90_000;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

interface Started {
  output: string;
  port: number;
  webPort: number;
}

/** Start the entry point with `args`, wait for its "Data folder:" line, then stop it. */
async function startAndStop(args: string[]): Promise<Started> {
  const port = await freePort();
  let webPort = await freePort();
  while (webPort === port) webPort = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LUCK_HOST: '127.0.0.1',
      LUCK_PORT: String(port),
      LUCK_WEB_PORT: String(webPort),
      LUCK_DATA_DIR: path.join(SCRATCH, randomUUID()),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "Data folder:" line within ${START_TIMEOUT_MS} ms:\n${output}`)), START_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('Data folder:')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}):\n${output}`));
      });
    });
  } finally {
    // our own child on an ephemeral port; SIGINT runs the normal shutdown where signals exist
    if (child.exitCode === null) child.kill('SIGINT');
    const killLater = setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 15_000);
    await exited;
    clearTimeout(killLater);
  }
  return { output, port, webPort };
}

describe('server startup message (real entry point, ephemeral ports)', () => {
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('the dev:server script (npm run dev) passes --dev-runner to the watched server, not to the port check', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const [check, watch] = pkg.scripts['dev:server'].split('&&').map((s) => s.trim());
    expect(check).toBe('tsx src/server/index.ts --check-port');
    expect(watch).toMatch(/^tsx watch .*src\/server\/index\.ts --dev-runner$/);
    // cross-platform: no inline environment variables (VAR=value cmd does not work in cmd.exe / PowerShell)
    expect(pkg.scripts['dev:server']).not.toMatch(/\b[A-Z_]+=\S/);
  });

  it('with --dev-runner: points to the Vite web UI on LUCK_WEB_PORT', async () => {
    const { output, port, webPort } = await startAndStop(['--dev-runner']);
    expect(output).toContain(`Luck API server is running at http://127.0.0.1:${port} (development mode).`);
    expect(output).toContain(`Open http://127.0.0.1:${webPort} in your browser (the web UI with hot reload, started by "npm run dev").`);
    if (output.includes('also serves')) {
      expect(output).toContain(`Note: http://127.0.0.1:${port} also serves a production build from dist/web (may be out of date).`);
    }
    expect(output).not.toMatch(/OLDER/);
  }, 120_000);

  it('started directly without --production (no --dev-runner): never sends you to the Vite URL', async () => {
    const { output, port, webPort } = await startAndStop([]);
    expect(output).not.toContain(`:${webPort}`);
    expect(output).not.toMatch(/hot reload|OLDER/);
    if (output.includes('Luck is running at')) {
      // a build in dist/web: this port serves it
      expect(output).toContain(`Open http://127.0.0.1:${port} in your browser.`);
      expect(output).toContain('serves a production build from dist/web (may be out of date)');
    } else {
      expect(output).toContain(`Luck API server is running at http://127.0.0.1:${port}`);
      expect(output).toContain('No built frontend found in dist/web.');
    }
  }, 120_000);
});
