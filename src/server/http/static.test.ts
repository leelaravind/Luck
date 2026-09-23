/**
 * Production static serving + SPA fallback, using a tiny FIXTURE build written to tmp/1
 * (not the real dist/web).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { findRepoRoot } from '../config.js';
import { OK_HEADERS, createFakeService, testConfig } from './__tests__/fake-service.js';

const webDir = join(findRepoRoot(), 'tmp', '1', 'fixture-web-dist');
/** A file NEXT TO the web root that must never be reachable through it. */
const outsideFile = join(findRepoRoot(), 'tmp', '1', 'fixture-outside-secret.txt');
const OUTSIDE_MARKER = 'FIXTURE-OUTSIDE-WEB-ROOT-4d1c';

beforeAll(() => {
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>fixture</title><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log("fixture")');
  writeFileSync(outsideFile, OUTSIDE_MARKER);
});
afterAll(() => {
  rmSync(webDir, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function makeApp() {
  app = await buildApp({ config: testConfig({ webDistDir: webDir }), service: createFakeService() });
  return app;
}

describe('static frontend (production build present)', () => {
  it('serves index.html at / with security headers', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/', headers: OK_HEADERS });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.body).toContain('fixture');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('serves hashed assets', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: OK_HEADERS });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers['cache-control']).toMatch(/immutable/);
  });

  it('falls back to index.html for client-side routes', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/sessions/abc', headers: OK_HEADERS });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<div id="root">');
  });

  it('does not answer missing files or /api paths with HTML', async () => {
    const app = await makeApp();
    const asset = await app.inject({ method: 'GET', url: '/assets/missing.js', headers: OK_HEADERS });
    expect(asset.statusCode).toBe(404);
    const api = await app.inject({ method: 'GET', url: '/api/unknown', headers: OK_HEADERS });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('sets Cache-Control through setHeaders: no-cache for the app shell, immutable only for hashed assets', async () => {
    const app = await makeApp();
    const root = await app.inject({ method: 'GET', url: '/', headers: OK_HEADERS });
    expect(root.headers['cache-control']).toBe('no-cache');
    const index = await app.inject({ method: 'GET', url: '/index.html', headers: OK_HEADERS });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toBe('no-cache');
    const route = await app.inject({ method: 'GET', url: '/sessions/abc', headers: OK_HEADERS });
    expect(route.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js', headers: OK_HEADERS });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const head = await app.inject({ method: 'HEAD', url: '/assets/app-abc123.js', headers: OK_HEADERS });
    expect(head.statusCode).toBe(200);
  });

  it('never serves files outside the web root (plain, encoded and backslash traversal)', async () => {
    const app = await makeApp();
    for (const url of [
      '/../fixture-outside-secret.txt',
      '/%2e%2e/fixture-outside-secret.txt',
      '/%2e%2e%2ffixture-outside-secret.txt',
      '/assets/..%2f..%2ffixture-outside-secret.txt',
      '/assets/%2e%2e%5c%2e%2e%5cfixture-outside-secret.txt',
      '/..%5cfixture-outside-secret.txt',
      '/assets%2f..%2f..%2ffixture-outside-secret.txt',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: OK_HEADERS });
      expect(r.body, url).not.toContain(OUTSIDE_MARKER);
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });

  it('does not list directories', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/assets/', headers: OK_HEADERS });
    expect(r.body).not.toContain('app-abc123.js');
  });

  it('still enforces the Host allow-list on static files', async () => {
    const app = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/', headers: { host: 'rebound.evil.example:3717' } });
    expect(r.statusCode).toBe(403);
  });
});
