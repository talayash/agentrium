import { PanelLeft, FileDiff, Users, Lightbulb, Monitor, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { usePreviewStore } from '../store/previewStore';
import { Tooltip } from './ui/Tooltip';

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
  // Active = filled rounded square in the accent tint (macOS Finder-sidebar
  // icon behavior) - no edge stripe. Tooltip opens toward the editor.
  const { Icon } = item;

  return (
    <Tooltip label={item.label} shortcut={item.shortcut} side={side === 'left' ? 'right' : 'left'}>
      <button
        onClick={item.onClick}
        aria-label={`${item.label} (${item.shortcut})`}
        aria-pressed={item.active}
        className={`group relative w-full h-9 flex items-center justify-center transition-[color,transform] duration-100 active:scale-95 ${
          item.active ? 'text-accent-primary' : 'text-text-tertiary hover:text-text-primary'
        }`}
      >
        {/* hover / active fill */}
        <span
          className={`absolute inset-x-1 inset-y-0.5 rounded-md transition-colors duration-100 ${
            item.active ? 'bg-accent-primary/14' : 'group-hover:bg-fill-hover'
          }`}
        />
        <Icon size={17} strokeWidth={1.75} className="relative" />
      </button>
    </Tooltip>
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
  const previewOpen = usePreviewStore((s) => s.globalOpen);
  const togglePreview = usePreviewStore((s) => s.toggleGlobal);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleChanges = useAppStore((s) => s.toggleChanges);
  const toggleOrchestration = useAppStore((s) => s.toggleOrchestration);
  const toggleHints = useAppStore((s) => s.toggleHints);
  const openSettings = useAppStore((s) => s.openSettings);

  // Consolidated rail (matches the sketch): all tool-window toggles live in
  // the LEFT stripe stacked vertically, Settings pinned to the bottom.
  // The right-side ToolStripe is now a no-op so App.tsx doesn't need to
  // change; that side simply doesn't render anything.
  if (side === 'right') return null;

  const top: StripeItem[] = [
    { id: 'project', label: 'Project',      shortcut: 'Ctrl+B',      Icon: PanelLeft, active: sidebarOpen,        onClick: toggleSidebar },
    { id: 'changes', label: 'Git',          shortcut: 'F2',          Icon: FileDiff,  active: changesOpen,        onClick: toggleChanges },
    { id: 'teams',   label: 'Agent Teams',  shortcut: 'F4',          Icon: Users,     active: orchestrationOpen,  onClick: toggleOrchestration },
    { id: 'hints',   label: 'Commands',     shortcut: 'F1',          Icon: Lightbulb, active: hintsOpen,          onClick: toggleHints },
    { id: 'preview', label: 'Preview',      shortcut: 'Ctrl+Alt+P',  Icon: Monitor,   active: previewOpen,        onClick: togglePreview },
  ];

  const bottom: StripeItem[] = [
    { id: 'settings', label: 'Settings', shortcut: 'Ctrl+,', Icon: Settings, active: settingsOpen, onClick: openSettings },
  ];

  return (
    <div className="w-[var(--w-rail)] flex-shrink-0 h-full material-chrome rounded-2xl shadow-elevation-2 flex flex-col py-1">
      <div className="flex flex-col">
        {top.map((it) => (
          <StripeButton key={it.id} item={it} side="left" />
        ))}
      </div>
      <div className="mt-auto flex flex-col">
        {bottom.map((it) => (
          <StripeButton key={it.id} item={it} side="left" />
        ))}
      </div>
    </div>
  );
}
