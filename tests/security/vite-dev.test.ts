/**
 * SECURITY — the Vite development server (`npm run dev`, port 5717 by default).
 *
 * Starts Vite programmatically with the project's real vite.config.ts on an EPHEMERAL port (never 5717/3717,
 * so it can run next to a running `npm run dev`) and checks, over real HTTP:
 *   - database files, local data/ and tmp/ folders, .env*, .git and files outside the web sources are refused
 *     (403) and never returned — the audit's repro was GET /@fs/<repo>/data/luck.db → 200 "SQLite format 3";
 *   - no Access-Control-Allow-Origin is sent to another local origin (Vite's default CORS answers every
 *     http://localhost:* / 127.0.0.1:* origin);
 *   - the app itself (index.html, /main.tsx, the src/shared modules it imports) is still served.
 * The deny list is also checked with Vite's own matcher for checkouts in awkward folders (/tmp/Luck,
 * D:/Data/Luck, "Projects (old)", "[work]"), where an unanchored data/tmp glob would deny the whole app.
 *
 * Throw-away probe files live in tmp/vite-dev-<uuid>/ and are removed afterwards. The test server uses its
 * own cache folder and no dependency optimisation, so it never touches node_modules/.vite of a running dev server.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, isFileLoadingAllowed, resolveConfig, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devFsAllow, devFsDeny } from '../../vite.config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const slash = (p: string) => p.replace(/\\/g, '/');
const ROOT = slash(REPO_ROOT);
const SCRATCH = path.join(REPO_ROOT, 'tmp', `vite-dev-${randomUUID()}`);
const PROBE_MARKER = `probe-${randomUUID()}`;
const SQLITE_MAGIC = 'SQLite format 3';

/** URL path for Vite's /@fs/ route (absolute file system path, forward slashes, URI-encoded). */
const fsUrl = (absPath: string) => encodeURI(`/@fs/${slash(absPath).replace(/^\//, '')}`);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: ViteDevServer | undefined;
let port = 0;

function get(urlPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Accept: '*/*', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('latin1') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(45_000, () => req.destroy(new Error(`timeout: ${method} ${urlPath}`)));
    req.end();
  });
}

describe('SECURITY: Vite dev server (real vite.config.ts, ephemeral port)', () => {
  const probeDb = path.join(SCRATCH, 'data', 'luck.db');
  const probeWal = path.join(SCRATCH, 'data', 'luck.db-wal');
  const probeText = path.join(SCRATCH, 'data', 'notes.txt');

  beforeAll(async () => {
    mkdirSync(path.dirname(probeDb), { recursive: true });
    writeFileSync(probeDb, `${SQLITE_MAGIC}\0${PROBE_MARKER} throw-away probe, not a real database`);
    writeFileSync(probeWal, `${PROBE_MARKER} wal`);
    writeFileSync(probeText, `${PROBE_MARKER} text`);
    server = await createServer({
      configFile: path.join(REPO_ROOT, 'vite.config.ts'),
      logLevel: process.env.VITE_TEST_LOG ? 'info' : 'silent',
      clearScreen: false,
      cacheDir: path.join(SCRATCH, 'vite-cache'),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, strictPort: false, hmr: false, ws: false, watch: null },
    });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    // never let a slow close hang the suite; the server is ours and on an ephemeral port
    await Promise.race([server?.close(), new Promise((r) => setTimeout(r, 20_000).unref())]);
    rmSync(SCRATCH, { recursive: true, force: true });
  }, 30_000);

  it('uses the hardened settings (cors off, strict fs, explicit allow list)', () => {
    const cfg = server!.config;
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(5717);
    expect(cfg.server.cors).toBe(false);
    expect(cfg.server.fs.strict).toBe(true);
    expect(cfg.server.fs.allow.map((d) => d.toLowerCase()).sort()).toEqual(
      [`${ROOT}/node_modules`, `${ROOT}/src/shared`, `${ROOT}/src/web`].map((d) => d.toLowerCase()).sort(),
    );
    expect(slash(cfg.root).toLowerCase()).toBe(`${ROOT}/src/web`.toLowerCase());
  });

  it('GET /@fs/<repo>/data/luck.db is refused and never returns database bytes (audit repro)', async () => {
    const realDb = path.join(REPO_ROOT, 'data', 'luck.db');
    const r = await get(fsUrl(realDb), { Origin: 'http://127.0.0.1:9999' });
    expect(r.body.startsWith(SQLITE_MAGIC)).toBe(false);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    // Vite answers 403 for a readable denied file; without a local database it falls through to 404/index.html.
    if (existsSync(realDb)) expect(r.status).toBe(403);
  });

  it('throw-away database, WAL and data files under tmp/…/data/ → 403 without their content', async () => {
    for (const file of [probeDb, probeWal, probeText]) {
      const r = await get(fsUrl(file));
      expect(r.status, file).toBe(403);
      expect(r.body.includes(PROBE_MARKER), file).toBe(false);
      expect(r.body.includes(SQLITE_MAGIC), file).toBe(false);
    }
    // the same file reached with ../ from the web root: never its content (Vite normalises the path and
    // answers 403, 404 or the SPA's index.html)
    const rel = slash(path.relative(path.join(REPO_ROOT, 'src', 'web'), probeDb));
    for (const p of [`/${encodeURI(rel)}`, `/${rel.split('/').map(encodeURIComponent).join('%2F')}`]) {
      const r = await get(p);
      expect(r.body.includes(PROBE_MARKER), p).toBe(false);
      expect(r.body.includes(SQLITE_MAGIC), p).toBe(false);
      if (r.status === 200) expect(r.headers['content-type'], p).toMatch(/text\/html/);
    }
  });

  it('files outside src/web, src/shared and node_modules → 403 (.env.example, package.json, server code, .git)', async () => {
    const outside = [
      path.join(REPO_ROOT, 'package.json'),
      path.join(REPO_ROOT, '.env.example'),
      path.join(REPO_ROOT, 'src', 'server', 'config.ts'),
      path.join(REPO_ROOT, 'docs', 'configuration.md'),
      path.join(REPO_ROOT, '.env'),
      path.join(REPO_ROOT, '.git', 'config'),
    ].filter((f) => existsSync(f));
    expect(outside.length).toBeGreaterThanOrEqual(4);
    for (const file of outside) {
      const r = await get(fsUrl(file));
      expect(r.status, file).toBe(403);
    }
  });

  it('no CORS grant for another local origin (GET and preflight)', async () => {
    for (const origin of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://evil.example']) {
      const r = await get('/main.tsx', { Origin: origin });
      expect(r.status).toBe(200);
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
      const pre = await get('/main.tsx', { Origin: origin, 'Access-Control-Request-Method': 'GET' }, 'OPTIONS');
      expect(pre.headers['access-control-allow-origin'], origin).toBeUndefined();
      expect(pre.headers['access-control-allow-methods'], origin).toBeUndefined();
    }
  });

  it('the app is still served: index.html, /main.tsx, the src/shared modules it imports, dev headers', async () => {
    const index = await get('/', { Accept: 'text/html' });
    expect(index.status).toBe(200);
    expect(index.body).toContain('<div id="root">');
    expect(index.headers['x-frame-options']).toBe('DENY');

    const main = await get('/main.tsx');
    expect(main.status).toBe(200);
    expect(main.headers['content-type']).toMatch(/javascript/);
    expect(main.body).toMatch(/createRoot|react-dom/);

    const shared = await get(fsUrl(path.join(REPO_ROOT, 'src', 'shared', 'contracts.ts')));
    expect(shared.status).toBe(200);
    expect(shared.headers['content-type']).toMatch(/javascript/);

    const client = await get('/@vite/client');
    expect(client.status).toBe(200);
  }, 120_000);
});

describe('SECURITY: Vite fs deny list is anchored to the checkout (Vite matcher, no server)', () => {
  const base = process.platform === 'win32' ? 'C:' : '';
  const roots = [
    `${base}/tmp/Luck`,
    `${base}/Data/Luck`,
    `${base}/Users/me/Projects (old)/Luck`,
    `${base}/work/[lab]/Luck`,
    `${base}/work/{a,b}/Luck!`,
  ];

  it.each(roots)('checkout at %s: app files allowed; data/, tmp/, databases, .env and .git denied', async (root) => {
    const cfg = await resolveConfig(
      {
        configFile: false,
        logLevel: 'silent',
        root: `${root}/src/web`,
        envDir: false,
        cacheDir: path.join(SCRATCH, 'unused-cache'),
        server: { fs: { strict: true, allow: devFsAllow(root), deny: devFsDeny(root) } },
      },
      'serve',
    );
    const allowed = (p: string) => isFileLoadingAllowed(cfg, `${root}/${p}`);

    expect(allowed('src/web/main.tsx')).toBe(true);
    expect(allowed('src/web/components/table/BettingTable.tsx')).toBe(true);
    expect(allowed('src/shared/contracts.ts')).toBe(true);
    expect(allowed('node_modules/react/index.js')).toBe(true);
    expect(allowed('node_modules/.vite/deps/react.js')).toBe(true);

    expect(allowed('data/luck.db')).toBe(false);
    expect(allowed('data/notes.txt')).toBe(false);
    expect(allowed('tmp/10/test.sqlite')).toBe(false);
    expect(allowed('package.json')).toBe(false);
    expect(allowed('src/server/config.ts')).toBe(false);
    // deny beats allow inside the served folders
    expect(allowed('src/web/luck.db')).toBe(false);
    expect(allowed('src/web/copy.db-wal')).toBe(false);
    expect(allowed('node_modules/pkg/cache.sqlite3')).toBe(false);
    expect(allowed('node_modules/pkg/.env')).toBe(false);
    expect(allowed('src/web/.env.local')).toBe(false);
    expect(allowed('node_modules/pkg/key.pem')).toBe(false);
    expect(allowed('node_modules/pkg/.git/config')).toBe(false);
  });
});
