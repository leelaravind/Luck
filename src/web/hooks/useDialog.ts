/**
 * Modal dialog behaviour: focus moves into the dialog when it opens, Tab stays inside it, Escape
 * closes it, and focus returns to the element that opened it.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden'));
}

export interface UseDialogOptions {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function useDialog({ open, onClose }: UseDialogOptions): {
  ref: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      // Prefer the first form field over the header's close button.
      const items = focusableIn(root);
      (items.find((el) => el.matches('input, select, textarea')) ?? items[0] ?? root).focus();
    }
    return () => {
      opener.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = focusableIn(ref.current);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return { ref, onKeyDown };
}
