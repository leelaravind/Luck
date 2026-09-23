/** Page Visibility API: background tabs settle the wheel immediately (no hidden animations). */
import { useEffect, useState } from 'react';

export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(isPageHidden);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setHidden(isPageHidden());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}
