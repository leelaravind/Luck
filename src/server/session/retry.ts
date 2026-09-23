/**
 * Bounded retry helpers for model decisions. The runner owns retries (adapters never retry).
 */
import type { ProviderError } from '../../shared/contracts.js';

/** Upper bound for a provider-supplied Retry-After. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Exponential base delays for attempts 1, 2, 3+ when the provider gave no Retry-After. */
const BACKOFF_BASE_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Jitter added on top of the base delay, as a fraction of it (0..25 %). */
const BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Delay before the next attempt after `failedAttempt` (1-based) failed.
 * - provider Retry-After is honoured exactly, capped at 30 s
 * - otherwise 1 s, 2 s, 4 s (then 4 s) plus up to 25 % random jitter
 */
export function computeBackoffMs(
  failedAttempt: number,
  error: Pick<ProviderError, 'retryAfterMs'> | null,
  random: () => number = Math.random,
): number {
  const retryAfter = error?.retryAfterMs;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(Math.round(retryAfter), MAX_RETRY_AFTER_MS);
  }
  const idx = Math.min(Math.max(failedAttempt, 1), BACKOFF_BASE_MS.length) - 1;
  const base = BACKOFF_BASE_MS[idx]!;
  const jitter = Math.floor(base * BACKOFF_JITTER_FRACTION * clamp01(random()));
  return base + jitter;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Default abortable sleep. Resolves (never rejects) when the timer fires or the signal aborts;
 * callers check `signal.aborted` afterwards.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wait with an injectable sleep. A sleep that rejects on abort is treated like one that resolves.
 * Returns true when the wait was cut short by the signal.
 */
export async function waitAbortable(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return true;
  try {
    await sleep(Math.max(0, ms), signal);
  } catch {
    /* aborted sleeps may reject; the signal is checked below */
  }
  return signal.aborted;
}

/** Yield to the macrotask queue so HTTP requests (pause/stop) are served between rounds. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
