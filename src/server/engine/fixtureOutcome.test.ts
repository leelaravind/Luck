/**
 * Tests for the TEST-ONLY fixture outcome source, plus guards that production wiring cannot
 * reach it through the engine entry point or a non-test import.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as engine from './index.js';
import { createFixtureOutcomeSource } from './fixtureOutcome.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createFixtureOutcomeSource', () => {
  it('returns the scripted numbers in order and counts calls', () => {
    const src = createFixtureOutcomeSource([17, 0, 36, 17]);
    expect(src.kind).toBe('fixture');
    expect(src.calls).toBe(0);
    expect(src.remaining).toBe(4);
    expect([src.next(), src.next(), src.next(), src.next()]).toEqual([17, 0, 36, 17]);
    expect(src.calls).toBe(4);
    expect(src.remaining).toBe(0);
  });

  it('throws once exhausted (and counts the failed call)', () => {
    const src = createFixtureOutcomeSource([5]);
    expect(src.next()).toBe(5);
    expect(() => src.next()).toThrow(/exhausted/);
    expect(() => src.next()).toThrow(/exhausted/);
    expect(src.calls).toBe(3);
    expect(src.remaining).toBe(0);
  });

  it('an empty script fails on the first draw (useful to prove no outcome is drawn)', () => {
    const src = createFixtureOutcomeSource([]);
    expect(src.calls).toBe(0);
    expect(() => src.next()).toThrow(/exhausted/);
    expect(src.calls).toBe(1);
  });

  it.each([37, -1, 1.5, Number.NaN, '3', null])('rejects invalid scripted outcome %o', (bad) => {
    expect(() => createFixtureOutcomeSource([1, bad as number])).toThrow(/Fixture outcome #1/);
  });

  it('rejects a non-array script', () => {
    expect(() => createFixtureOutcomeSource('17' as unknown as number[])).toThrow(TypeError);
  });

  it('copies the script (later mutation of the caller array has no effect)', () => {
    const seq = [1, 2];
    const src = createFixtureOutcomeSource(seq);
    seq[0] = 99;
    seq.push(3);
    expect(src.next()).toBe(1);
    expect(src.next()).toBe(2);
    expect(() => src.next()).toThrow(/exhausted/);
  });

  it('refuses to be created when NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createFixtureOutcomeSource([1])).toThrow(/test-only/);
  });
});

describe('production wiring cannot reach the fixture source', () => {
  it('the engine entry point exports the crypto source and not the fixture', () => {
    expect(typeof engine.createCryptoOutcomeSource).toBe('function');
    expect(engine.createCryptoOutcomeSource().kind).toBe('crypto');
    expect(Object.keys(engine)).not.toContain('createFixtureOutcomeSource');
  });

  it('no non-test file under src/server imports fixtureOutcome', () => {
    const serverDir = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(serverDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) continue;
      const full = join(entry.parentPath, entry.name);
      const rel = relative(serverDir, full).replaceAll('\\', '/');
      const isTestCode = /\.test\.[a-z]+$/.test(rel) || rel.includes('__tests__/') || rel === 'engine/fixtureOutcome.ts';
      if (isTestCode) continue;
      // Static `from '…fixtureOutcome…'` / `require('…')` or dynamic `import('…')` of the module (comments are fine).
      const importsFixture = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*fixtureOutcome[^'"]*['"]/;
      if (importsFixture.test(readFileSync(full, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
