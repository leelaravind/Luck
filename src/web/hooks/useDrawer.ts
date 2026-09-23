/** Collapsible bottom drawer: open state + selected tab, remembered per browser. */
import { useCallback, useState } from 'react';
import { DRAWER_TABS, type DrawerTab } from '../copy';
import { readStored, STORAGE_KEYS, writeStored } from '../state/storage';

function storedTab(): DrawerTab {
  const t = readStored(STORAGE_KEYS.drawerTab);
  return t && (DRAWER_TABS as string[]).includes(t) ? (t as DrawerTab) : 'logs';
}

export function useDrawer() {
  const [open, setOpenState] = useState(() => readStored(STORAGE_KEYS.drawerOpen) === '1');
  const [tab, setTabState] = useState<DrawerTab>(storedTab);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    writeStored(STORAGE_KEYS.drawerOpen, v ? '1' : '0');
  }, []);
  const setTab = useCallback((t: DrawerTab) => {
    setTabState(t);
    writeStored(STORAGE_KEYS.drawerTab, t);
  }, []);
  /** Open the drawer on a given tab (e.g. header Settings button). */
  const openTab = useCallback(
    (t: DrawerTab) => {
      setTab(t);
      setOpen(true);
    },
    [setOpen, setTab],
  );
  return { open, setOpen, tab, setTab, openTab };
}

export type DrawerState = ReturnType<typeof useDrawer>;
