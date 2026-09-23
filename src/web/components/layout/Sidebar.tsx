import type { ReactNode } from 'react';

/**
 * The ONE compact sidebar (player, provider config, usage, latest decision).
 * Desktop (>= 1280px): always visible, sticky column. Tablet: collapsible column. Mobile (< 768px):
 * a collapsible "Player & usage" section above the table. The toggle lives in SidebarToggle.
 */
export interface SidebarProps {
  readonly id: string;
  readonly open: boolean;
  readonly children: ReactNode;
}

export function Sidebar({ id, open, children }: Readonly<SidebarProps>) {
  return (
    <aside
      id={id}
      aria-label="Player and usage"
      className={`${open ? 'flex' : 'hidden'} w-full shrink-0 flex-col gap-3 md:w-72 xl:sticky xl:top-[4.25rem] xl:flex xl:max-h-[calc(100dvh-5rem)] xl:overflow-y-auto xl:pb-4`}
    >
      {children}
    </aside>
  );
}

export default Sidebar;
