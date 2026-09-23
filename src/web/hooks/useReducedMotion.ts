/**
 * Reduced-motion preference: the app setting ('on' / 'off') overrides the operating-system preference;
 * 'system' follows `prefers-reduced-motion` live via matchMedia.
 */
import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/contracts';

const QUERY = '(prefers-reduced-motion: reduce)';

function systemPrefersReduced(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(QUERY).matches
      : false;
  } catch {
    return false;
  }
}

export function resolveReducedMotion(setting: AppSettings['reduceMotion'], systemReduced: boolean): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return systemReduced;
}

/** Live value of the OS-level prefers-reduced-motion media query. */
export function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(systemPrefersReduced);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const onChange = () => setReduced(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Older Safari
    mql.addListener?.(onChange);
    return () => mql.removeListener?.(onChange);
  }, []);
  return reduced;
}

export function useReducedMotion(setting: AppSettings['reduceMotion'] = 'system'): boolean {
  return resolveReducedMotion(setting, useSystemReducedMotion());
}
