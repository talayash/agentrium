import { PanelLeft, FileDiff, Users, Lightbulb, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';

type Side = 'left' | 'right';

interface StripeItem {
  id: string;
  label: string;
  shortcut: string;
  Icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}

function StripeButton({ item, side }: { item: StripeItem; side: Side }) {
  // The active indicator hugs the window edge (IntelliJ "stripe"): left rail →
  // left edge, right rail → right edge. Tooltip opens toward the editor.
  const stripeEdge = side === 'left' ? 'left-0' : 'right-0';
  const tooltipSide = side === 'left' ? 'left-full ml-1.5' : 'right-full mr-1.5';
  const { Icon } = item;

  return (
    <button
      onClick={item.onClick}
      aria-label={`${item.label} (${item.shortcut})`}
      aria-pressed={item.active}
      className={`group relative w-full h-9 flex items-center justify-center transition-colors ${
        item.active ? 'text-accent-primary' : 'text-text-tertiary hover:text-text-primary'
      }`}
    >
      {/* hover / active fill */}
      <span
        className={`absolute inset-x-1 inset-y-0.5 rounded transition-colors ${
          item.active ? 'bg-accent-primary/10' : 'group-hover:bg-white/[0.06]'
        }`}
      />
      {/* active edge stripe */}
      {item.active && (
        <span className={`absolute ${stripeEdge} top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent-primary`} />
      )}
      <Icon size={17} strokeWidth={1.75} />
      {/* styled tooltip (label + shortcut) */}
      <span
        className={`pointer-events-none absolute ${tooltipSide} top-1/2 -translate-y-1/2 z-[60] whitespace-nowrap rounded-md bg-elevation-3 ring-1 ring-[var(--ij-divider-soft)] px-2 py-1 text-[11.5px] text-text-primary opacity-0 group-hover:opacity-100 transition-opacity duration-100`}
      >
        {item.label}
        <span className="ml-2 text-text-tertiary">{item.shortcut}</span>
      </span>
    </button>
  );
}

/**
 * IntelliJ "New UI" tool-window stripe: a thin icon rail pinned to the window
 * edge that toggles tool windows. Left rail anchors the Project sidebar (and
 * Settings at the bottom); right rail anchors Git / Agent Teams /
 * Commands. Drives the same appStore toggles as the keyboard shortcuts.
 */
export function ToolStripe({ side }: { side: Side }) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const changesOpen = useAppStore((s) => s.changesOpen);
  const orchestrationOpen = useAppStore((s) => s.orchestrationOpen);
  const hintsOpen = useAppStore((s) => s.hintsOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleChanges = useAppStore((s) => s.toggleChanges);
  const toggleOrchestration = useAppStore((s) => s.toggleOrchestration);
  const toggleHints = useAppStore((s) => s.toggleHints);
  const openSettings = useAppStore((s) => s.openSettings);

  const top: StripeItem[] =
    side === 'left'
      ? [{ id: 'project', label: 'Project', shortcut: 'Ctrl+B', Icon: PanelLeft, active: sidebarOpen, onClick: toggleSidebar }]
      : [
          { id: 'changes', label: 'Git', shortcut: 'F2', Icon: FileDiff, active: changesOpen, onClick: toggleChanges },
          { id: 'teams', label: 'Agent Teams', shortcut: 'F4', Icon: Users, active: orchestrationOpen, onClick: toggleOrchestration },
          { id: 'hints', label: 'Commands', shortcut: 'F1', Icon: Lightbulb, active: hintsOpen, onClick: toggleHints },
        ];

  const bottom: StripeItem[] =
    side === 'left'
      ? [{ id: 'settings', label: 'Settings', shortcut: 'Ctrl+,', Icon: Settings, active: settingsOpen, onClick: openSettings }]
      : [];

  const edgeBorder = side === 'left' ? 'border-r' : 'border-l';

  return (
    <div className={`w-10 flex-shrink-0 h-full bg-elevation-1 ${edgeBorder} border-[var(--ij-divider)] flex flex-col py-1`}>
      <div className="flex flex-col">
        {top.map((it) => (
          <StripeButton key={it.id} item={it} side={side} />
        ))}
      </div>
      {bottom.length > 0 && (
        <div className="mt-auto flex flex-col">
          {bottom.map((it) => (
            <StripeButton key={it.id} item={it} side={side} />
          ))}
        </div>
      )}
    </div>
  );
}
