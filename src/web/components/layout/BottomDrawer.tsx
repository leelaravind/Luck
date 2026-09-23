import { Braces, ChartLine, ChevronUp, FolderOpen, ReceiptText, SlidersHorizontal, Terminal } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { DRAWER_TAB_LABEL, DRAWER_TABS, type DrawerTab } from '../../copy';
import { useTabs } from '../../hooks/useTabs';

/**
 * Collapsible drawer with keyboard-operable tabs (←/→/Home/End). Escape collapses it while focus is inside.
 * Collapsed, it shows only the tab bar; choosing a tab expands it.
 */
export interface BottomDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tab: DrawerTab;
  readonly onTab: (tab: DrawerTab) => void;
  readonly panels: Readonly<Record<DrawerTab, ReactNode>>;
  /** Optional count badges, e.g. { ledger: 38 }. */
  readonly counts?: Partial<Record<DrawerTab, number>>;
}

const ICON: Record<DrawerTab, ReactNode> = {
  logs: <Terminal aria-hidden="true" className="h-3.5 w-3.5" />,
  chart: <ChartLine aria-hidden="true" className="h-3.5 w-3.5" />,
  ledger: <ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />,
  history: <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />,
  raw: <Braces aria-hidden="true" className="h-3.5 w-3.5" />,
  settings: <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />,
};

export function BottomDrawer({ open, onOpenChange, tab, onTab, panels, counts = {} }: Readonly<BottomDrawerProps>) {
  const select = (t: DrawerTab) => {
    onTab(t);
    if (!open) onOpenChange(true);
  };
  const { getTabProps, getPanelProps } = useTabs({ ids: DRAWER_TABS, selected: tab, onSelect: select });
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      onOpenChange(false);
      // Keep focus on something visible: the active tab.
      document.getElementById(getTabProps(tab).id)?.focus();
    }
  };

  return (
    <section aria-label="Details drawer" onKeyDown={onKeyDown} className="min-w-0 rounded-card border border-hairline bg-card shadow-card">
      <div className="flex items-center gap-2 border-b border-hairline p-1.5">
        <div role="tablist" aria-label="Details" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {DRAWER_TABS.map((t) => {
            const { ref, ...props } = getTabProps(t);
            const selected = t === tab && open;
            return (
              <button
                key={t}
                ref={ref}
                {...props}
                aria-selected={t === tab}
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
                  selected ? 'bg-ivory-deep text-ink shadow-inset-soft' : 'text-ink-muted hover:bg-card-muted hover:text-ink'
                }`}
              >
                <span className={selected ? 'text-primary' : ''}>{ICON[t]}</span>
                {DRAWER_TAB_LABEL[t]}
                {counts[t] !== undefined ? <span className="tnum text-ink-muted">({counts[t]})</span> : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={getPanelProps(tab).id}
          onClick={() => onOpenChange(!open)}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-card-muted px-2.5 py-1 font-mono text-[11px] font-semibold text-ink hover:bg-ivory-deep"
        >
          {open ? 'Collapse' : 'Expand'}
          <ChevronUp aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {DRAWER_TABS.map((t) => {
        const props = getPanelProps(t);
        return (
          <div key={t} {...props} hidden={!open || t !== tab} className="min-w-0 p-3">
            {open && t === tab ? panels[t] : null}
          </div>
        );
      })}
    </section>
  );
}

export default BottomDrawer;
