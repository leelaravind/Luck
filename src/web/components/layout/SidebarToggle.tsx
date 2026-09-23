import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { COPY } from '../../copy';

/** Disclosure button for the sidebar below 1280px (hidden on desktop where the sidebar is always shown). */
export interface SidebarToggleProps {
  readonly controls: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function SidebarToggle({ controls, open, onToggle }: Readonly<SidebarToggleProps>) {
  const Icon = open ? PanelLeftClose : PanelLeftOpen;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-card px-3 py-2 text-sm font-semibold text-ink shadow-card hover:bg-ivory-deep xl:hidden"
    >
      <Icon aria-hidden="true" className="hidden h-4 w-4 text-primary md:block" />
      <span>{COPY.sidebarToggle}</span>
      <ChevronDown aria-hidden="true" className={`ml-auto h-4 w-4 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

export default SidebarToggle;
