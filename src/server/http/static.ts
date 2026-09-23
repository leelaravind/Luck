/**
 * Production frontend: when dist/web/index.html exists (after `npm run build`), serve the built
 * files from the same port as the API and fall back to index.html for client-side routes.
 * In development the Vite dev server serves the frontend instead and proxies /api here.
 *
 * Also owns the not-found handler: unknown /api paths always get a JSON ApiErrorBody 404.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { apiError } from './errors.js';
import { isApiPath, pathOf } from './security.js';

/** Whether a built frontend is available to serve. */
export function hasWebBuild(webDistDir: string): boolean {
  return existsSync(join(webDistDir, 'index.html'));
}

/** Last path segment has a file extension, e.g. /assets/app-1234.js (missing assets must 404, not get HTML). */
function looksLikeFile(path: string): boolean {
  const last = path.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]{1,8}$/.test(last);
}

export async function registerStaticAndFallback(app: FastifyInstance, webDistDir: string): Promise<boolean> {
  const serveWeb = hasWebBuild(webDistDir);

  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      index: ['index.html'],
      // We set Cache-Control ourselves below (send's default "max-age=0" would override it).
      cacheControl: false,
      // Vite emits content-hashed file names under /assets, so those can be cached for long.
      // @fastify/static >= 10 calls this with the Fastify reply (not the raw response).
      setHeaders(reply, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = pathOf(request.url);
    const isPageRequest = (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url) && !looksLikeFile(path);
    if (serveWeb && isPageRequest) {
      // SPA fallback: client-side routes render the app shell.
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    const message = isApiPath(request.url) ? `No API route ${request.method} ${path}.` : 'Not found.';
    return reply.code(404).type('application/json; charset=utf-8').send(apiError('not_found', message));
  });

  return serveWeb;
}
