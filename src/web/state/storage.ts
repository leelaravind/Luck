/**
 * Tiny localStorage wrapper for per-browser UI preferences. Storage can be unavailable (privacy mode,
 * disabled cookies, quota); every access is wrapped so the dashboard keeps working without it.
 * Nothing authoritative (balances, rounds) is ever stored here.
 */
const PREFIX = 'luck.';

export const STORAGE_KEYS = {
  selectedSessionId: `${PREFIX}selectedSessionId`,
  drawerOpen: `${PREFIX}drawerOpen`,
  drawerTab: `${PREFIX}drawerTab`,
} as const;

export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage unavailable: preference is simply not remembered.
  }
}
