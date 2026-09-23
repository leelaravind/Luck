// Unit tests for honest provider availability labels (fixture ProviderStatus objects).
import { describe, expect, it } from 'vitest';
import type { ConnectionTestResult, ProviderStatus } from '../../shared/contracts';
import { providerAvailability } from './availability';

const base: ProviderStatus = {
  kind: 'anthropic',
  capabilities: {
    kind: 'anthropic',
    label: 'Anthropic (fixture)',
    local: false,
    paid: true,
    generatesText: true,
    reportsTokenUsage: 'full',
    reportsCost: false,
    listsModels: true,
    structuredOutput: true,
    quotaInfo: 'rate-limit-headers',
    requiresApiKey: true,
    notes: [],
  },
  configured: true,
  enabled: true,
  issues: [],
  defaults: {},
  lastTest: null,
};

const test = (ok: boolean, testedAt: string): ConnectionTestResult => ({ ok, testedAt, latencyMs: 10, message: ok ? 'ok' : 'refused' });

describe('providerAvailability', () => {
  it('labels missing configuration, disabled adapters and untested providers', () => {
    expect(providerAvailability({ ...base, configured: false, issues: ['No key'] }).label).toBe('Not configured');
    expect(providerAvailability({ ...base, enabled: false }).label).toBe('Unavailable');
    expect(providerAvailability(base).label).toBe('Configured (untested)');
  });

  it('reports Connected / Failed only from a real test result, newest wins', () => {
    expect(providerAvailability({ ...base, lastTest: test(true, '2026-09-23T10:00:00Z') }).label).toBe('Connected');
    expect(providerAvailability({ ...base, lastTest: test(false, '2026-09-23T10:00:00Z') }).label).toBe('Failed');
    const a = providerAvailability({ ...base, lastTest: test(true, '2026-09-23T10:00:00Z') }, test(false, '2026-09-23T11:00:00Z'));
    expect(a.label).toBe('Failed');
    expect(a.title).toContain('refused');
  });
});
