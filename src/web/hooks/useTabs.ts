/**
 * WAI-ARIA tabs with a roving tabindex: Left/Right (and Up/Down) move between tabs, Home/End jump,
 * activation follows focus. Returns prop getters so components stay presentational.
 */
import { useCallback, useId, useRef, type KeyboardEvent } from 'react';

export interface UseTabsOptions<T extends string> {
  readonly ids: readonly T[];
  readonly selected: T;
  readonly onSelect: (id: T) => void;
}

export function useTabs<T extends string>({ ids, selected, onSelect }: UseTabsOptions<T>) {
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement | null>());

  const focusTab = useCallback(
    (id: T) => {
      onSelect(id);
      refs.current.get(id)?.focus();
    },
    [onSelect],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const i = ids.indexOf(selected);
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ids.length - 1;
      if (next === null) return;
      e.preventDefault();
      focusTab(ids[next]!);
    },
    [ids, selected, focusTab],
  );

  const tabId = (id: T) => `${base}-tab-${id}`;
  const panelId = (id: T) => `${base}-panel-${id}`;

  return {
    getTabProps: (id: T) => ({
      id: tabId(id),
      role: 'tab' as const,
      type: 'button' as const,
      'aria-selected': id === selected,
      'aria-controls': panelId(id),
      tabIndex: id === selected ? 0 : -1,
      onClick: () => onSelect(id),
      onKeyDown,
      ref: (el: HTMLButtonElement | null) => {
        refs.current.set(id, el);
      },
    }),
    getPanelProps: (id: T) => ({
      id: panelId(id),
      role: 'tabpanel' as const,
      'aria-labelledby': tabId(id),
      tabIndex: 0,
      hidden: id !== selected,
    }),
  };
}
