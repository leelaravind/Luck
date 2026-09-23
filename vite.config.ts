import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = Number(process.env.LUCK_PORT ?? 3717);
const WEB_PORT = Number(process.env.LUCK_WEB_PORT ?? 5717);

/** Repository root and source folders as absolute, forward-slash paths (from this file's location, not the cwd). */
const abs = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
export const REPO_ROOT = abs('./');
const SRC_WEB = abs('./src/web');

/**
 * Escape a literal path for use inside a picomatch glob (Vite's fs.deny matcher), so a checkout in a folder
 * such as "Projects (old)" or "[work]" still produces a pattern that matches only that folder.
 */
export function escapeGlobPath(p: string): string {
  return p.replace(/[\\^$[\]]/g, '\\$&').replace(/[*?{}()!+@|]/g, '[$&]');
}

/**
 * Files the dev server must never hand out, even from an allowed folder (fs.deny beats fs.allow).
 * Vite's own defaults are repeated because setting `deny` replaces them. The data/ and tmp/ folders are
 * anchored to THIS checkout: an unanchored "any folder named data" glob would also match a parent folder
 * (Vite matches the absolute path, case-insensitively) and deny the whole app for a checkout under
 * e.g. /tmp/Luck or D:/Data/Luck.
 */
export function devFsDeny(repoRoot: string = REPO_ROOT): string[] {
  const root = escapeGlobPath(repoRoot.replace(/\\/g, '/').replace(/\/$/, ''));
  return [
    // Vite defaults
    '.env',
    '.env.*',
    '*.{crt,pem,key,p12,pfx,cer,der}',
    '.npmrc',
    '.yarnrc.yml',
    '**/.git/**',
    // Luck's SQLite database (sessions, decisions, logs) and its journal/WAL files, wherever they are
    '*.db',
    '*.db-*',
    '*.sqlite*',
    // local data and scratch folders of this checkout
    `${root}/data/**`,
    `${root}/tmp/**`,
    `${root}/.git/**`,
  ];
}

/**
 * Folders the dev server may serve. The web app imports src/shared (contracts, bet rules) and packages from
 * node_modules; everything else in the repository — data/, tmp/, .env, .git, docs, the server — is refused
 * with 403.
 */
export function devFsAllow(repoRoot: string = REPO_ROOT): string[] {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  return [`${root}/src/web`, `${root}/src/shared`, `${root}/node_modules`];
}

export default defineConfig({
  root: SRC_WEB,
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    // No CORS middleware: Vite's default answers any http://localhost:* / 127.0.0.1:* origin with
    // Access-Control-Allow-Origin, which would let another local web page read dev-server responses.
    // The app itself is same-origin, so it needs no CORS grant.
    cors: false,
    // Only the web sources, the shared contracts and node_modules are served (see devFsAllow / devFsDeny).
    fs: { strict: true, allow: devFsAllow(), deny: devFsDeny() },
    // Dev UI gets frame protection too (reviewer D9). Vite HMR needs inline/eval + ws, so the CSP is
    // limited to what is safe in development; production responses use the strict CSP from the server.
    headers: {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    },
    proxy: {
      // Forward API calls only. The frontend also has a src/web/api/ source folder, so requests for
      // its modules (/api/client.ts, …) must stay with Vite instead of being proxied to the backend.
      '^/api/(?!.*\\.(?:ts|tsx|js|jsx|mjs|css|map)(?:\\?|$))': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  preview: { host: '127.0.0.1', port: WEB_PORT, strictPort: true },
});
