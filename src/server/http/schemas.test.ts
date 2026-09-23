/**
 * Request schemas + PUT /api/settings end to end against the REAL session service (in-memory
 * SQLite, fake adapters, no provider contacted): the AppSettingsPatch semantics (pricing merged key
 * by key, deletions only via pricingRemove, a built-in default key only reset to its default,
 * builtInPricingKeys read-only) and partial limits. All values are TEST FIXTURES.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_LIMITS, type AppSettings } from '../../shared/contracts.js';
import { DEFAULT_PRICING } from '../providers/pricing.js';
import { buildApp } from '../app.js';
import { makeHarness, type Harness } from '../session/__tests__/helpers.js';
import { OK_HEADERS, OK_POST_HEADERS, testConfig } from './__tests__/fake-service.js';
import { createSessionBody, settingsPatchBody } from './schemas.js';

let app: FastifyInstance | null = null;
let harness: Harness | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  if (harness) {
    await harness.service.shutdown();
    harness.repo.close();
    harness = null;
  }
});

async function realApp(): Promise<FastifyInstance> {
  harness = makeHarness();
  app = await buildApp({ config: testConfig(), service: harness.service });
  return app;
}

const put = (payload: unknown) => ({ method: 'PUT' as const, url: '/api/settings', headers: OK_POST_HEADERS, payload: payload as Record<string, unknown> });
const row = (n: number) => ({ inputPerMTokUsd: n, outputPerMTokUsd: n, source: 'user' as const });

describe('settingsPatchBody (shape)', () => {
  it('accepts pricingRemove and a read-only builtInPricingKeys; rejects malformed ones', () => {
    expect(settingsPatchBody.parse({ pricingRemove: ['openai:fixture-a'], builtInPricingKeys: ['x:y'] })).toEqual({
      pricingRemove: ['openai:fixture-a'],
      builtInPricingKeys: ['x:y'],
    });
    for (const bad of [
      { pricingRemove: 'openai:fixture-a' },
      { pricingRemove: [1] },
      { pricingRemove: [''] },
      { pricingRemove: ['k'.repeat(301)] },
      { pricingRemove: Array.from({ length: 1_001 }, (_, i) => `openai:fixture-${i}`) },
      { builtInPricingKeys: 'openai:fixture-a' },
      { pricingDelete: ['openai:fixture-a'] }, // strict: unknown keys are refused
    ]) {
      expect(settingsPatchBody.safeParse(bad).success).toBe(false);
    }
  });

  it('a partial create-session "limits" object gets no defaults added (allowModelStop stays omitted)', () => {
    expect(createSessionBody.parse({ player: { kind: 'demo' }, limits: { maxRounds: 1 } }).limits).toEqual({ maxRounds: 1 });
  });
});

describe('PUT /api/settings (real service)', () => {
  it('merges pricing key by key, deletes only via pricingRemove and reports builtInPricingKeys', async () => {
    const a = await realApp();
    const initial = (await a.inject({ method: 'GET', url: '/api/settings', headers: OK_HEADERS })).json() as AppSettings;
    expect(initial.builtInPricingKeys).toEqual(Object.keys(DEFAULT_PRICING));

    expect((await a.inject(put({ pricing: { 'openai:fixture-a': row(1) } }))).statusCode).toBe(200);
    // A stale tab saves its table without fixture-b… after another tab added it: nothing is lost.
    expect((await a.inject(put({ pricing: { 'openai:fixture-b': row(2) } }))).statusCode).toBe(200);
    const stale = await a.inject(put({ ...initial, pricing: { ...initial.pricing, 'openai:fixture-a': row(3) } }));
    expect(stale.statusCode).toBe(200); // the whole settings object (incl. builtInPricingKeys) can be sent back
    expect((stale.json() as AppSettings).pricing).toMatchObject({ 'openai:fixture-a': row(3), 'openai:fixture-b': row(2) });

    const removed = await a.inject(put({ pricingRemove: ['openai:fixture-b'] }));
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as AppSettings).pricing['openai:fixture-b']).toBeUndefined();
    const reloaded = (await a.inject({ method: 'GET', url: '/api/settings', headers: OK_HEADERS })).json() as AppSettings;
    expect(reloaded.pricing['openai:fixture-b']).toBeUndefined();
    expect(reloaded.pricing['openai:fixture-a']).toEqual(row(3));
  });

  it('removing a built-in key resets the user override to the default (the default never disappears); an orphan default-assumption row is removable', async () => {
    const a = await realApp();
    const builtIn = Object.keys(DEFAULT_PRICING)[0]!;
    const override = { ...DEFAULT_PRICING[builtIn]!, inputPerMTokUsd: 7, source: 'user' };
    expect((await a.inject(put({ pricing: { [builtIn]: override } }))).json().pricing[builtIn]).toEqual(override);
    const reset = await a.inject(put({ animationSpeed: 'fast', pricingRemove: [builtIn] }));
    expect(reset.statusCode).toBe(200);
    const after = (await a.inject({ method: 'GET', url: '/api/settings', headers: OK_HEADERS })).json() as AppSettings;
    expect(after.animationSpeed).toBe('fast');
    expect(after.pricing[builtIn]).toEqual(DEFAULT_PRICING[builtIn]);
    expect(after.builtInPricingKeys).toContain(builtIn);

    const orphan = { inputPerMTokUsd: 1, outputPerMTokUsd: 1, source: 'default-assumption', asOf: '2025-01-01' };
    expect((await a.inject(put({ pricing: { 'openai:fixture-ghost-old-default': orphan } }))).json().pricing['openai:fixture-ghost-old-default']).toEqual(orphan);
    const gone = await a.inject(put({ pricingRemove: ['openai:fixture-ghost-old-default'] }));
    expect(gone.statusCode).toBe(200);
    expect(gone.json().pricing['openai:fixture-ghost-old-default']).toBeUndefined();
  });

  it('POST /api/sessions with a partial "limits" object keeps a saved allowModelStop=true', async () => {
    const a = await realApp();
    harness!.service.updateSettings({ defaultLimits: { ...DEFAULT_LIMITS, allowModelStop: true } });
    const created = await a.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...OK_POST_HEADERS, 'idempotency-key': 'fixture-key-0001' },
      payload: { player: { kind: 'demo' }, limits: { maxRounds: 1 } },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().session.limits).toMatchObject({ allowModelStop: true, maxRounds: 1 });
  });
});
