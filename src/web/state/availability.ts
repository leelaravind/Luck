/**
 * Honest provider availability, derived only from server facts:
 *   Not configured       required config missing (e.g. no API key in the server's .env)
 *   Unavailable          configured but the adapter cannot be enabled (issues explain why)
 *   Configured (untested) no connection test has been run
 *   Connected            the most recent connection test succeeded (with its timestamp)
 *   Failed               the most recent connection test failed
 */
import type { ConnectionTestResult, ProviderStatus } from '../../shared/contracts';
import type { BadgeTone } from '../components/common/Badge';
import { formatTime } from './format';

export interface Availability {
  label: 'Not configured' | 'Unavailable' | 'Configured (untested)' | 'Connected' | 'Failed';
  tone: BadgeTone;
  title: string;
  /** Latest test (page-local test wins over the server's stored lastTest). */
  test: ConnectionTestResult | null;
}

export function latestTest(status: ProviderStatus, pageTest: ConnectionTestResult | undefined): ConnectionTestResult | null {
  const stored = status.lastTest;
  if (pageTest && (!stored || pageTest.testedAt >= stored.testedAt)) return pageTest;
  return stored ?? null;
}

export function providerAvailability(status: ProviderStatus, pageTest?: ConnectionTestResult): Availability {
  const issues = status.issues.length ? ` ${status.issues.join(' ')}` : '';
  const test = latestTest(status, pageTest);
  if (!status.configured) {
    return { label: 'Not configured', tone: 'neutral', title: `Required configuration is missing.${issues}`, test };
  }
  if (!status.enabled) {
    return { label: 'Unavailable', tone: 'warning', title: `This adapter cannot be used right now.${issues}`, test };
  }
  if (!test) {
    return {
      label: 'Configured (untested)',
      tone: 'secondary',
      title: `Configuration found, but no connection test has been run.${issues}`,
      test,
    };
  }
  if (test.ok) {
    return { label: 'Connected', tone: 'success', title: `Connection test passed at ${formatTime(test.testedAt)}. ${test.message}`, test };
  }
  return { label: 'Failed', tone: 'danger', title: `Connection test failed at ${formatTime(test.testedAt)}: ${test.message}`, test };
}
