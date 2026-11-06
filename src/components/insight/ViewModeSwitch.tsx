import { Columns, Layers, TerminalSquare, type LucideIcon } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import {
  VIEW_MODES,
  VIEW_MODE_LABELS,
  availableViewModes,
  effectiveViewMode,
  insightUnavailableReason,
  type ViewMode,
} from '../../lib/viewMode';
import { KEYMAP } from '../../lib/keymap';
import { Tooltip } from '../ui/Tooltip';

const CYCLE_SHORTCUT = KEYMAP.find((k) => k.id === 'cycle-view-mode')?.shortcut;

const ICONS: Record<ViewMode, LucideIcon> = {
  cli: TerminalSquare,
  mixed: Columns,
  insight: Layers,
};

/** Session header switch between CLI, Mixed and Insight. Hidden when only
 *  CLI is available (shells, script children). Segments the agent cannot
 *  drive stay visible but disabled. */
export function ViewModeSwitch({ terminalId, compact = false }: { terminalId: string; compact?: boolean }) {
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  const setViewMode = useTerminalStore((s) => s.setViewMode);
  if (!instance) return null;
  const available = availableViewModes(instance);
  if (available.length < 2) return null;
  const current = effectiveViewMode(instance);
  return (
    // Compact (toolbar) form is icon-only, so the tooltip names the mode.
    <Tooltip label={compact ? `View mode: ${VIEW_MODE_LABELS[current]}` : 'View mode'} shortcut={CYCLE_SHORTCUT}>
      <div
        role="radiogroup"
        aria-label="View mode"
        aria-keyshortcuts="Control+Shift+L"
        className={`no-drag flex items-center p-0.5 gap-0.5 rounded-lg bg-fill-subtle ring-inset ${
          // Icon-only segments lack text to define the group, so the
          // compact (toolbar) form gets a heavier, higher-contrast rim.
          compact ? 'h-6 ring-[1.5px] ring-seam-strong' : 'h-7 ring-1 ring-seam'
        }`}
      >
        {VIEW_MODES.map((mode) => {
          const enabled = available.includes(mode);
          const checked = mode === current;
          const Icon = ICONS[mode];
          const button = (
            <button
              key={mode}
              role="radio"
              aria-label={VIEW_MODE_LABELS[mode]}
              aria-checked={checked}
              aria-disabled={!enabled}
              data-tone={enabled ? 'view' : undefined}
              onClick={() => {
                if (enabled && !checked) void setViewMode(terminalId, mode);
              }}
              className={`tone-tab flex items-center gap-1 rounded-lg text-[11.5px] font-medium transition-colors ${compact ? 'h-5 px-1.5' : 'h-6 px-2'} ${
                checked
                  ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30'
                  : enabled
                    ? 'text-text-secondary hover:text-text-primary hover:bg-fill-hover'
                    : 'text-text-secondary/40 cursor-not-allowed'
              }`}
            >
              <Icon size={13} strokeWidth={1.75} />
              {!compact && <span className="hidden sm:inline">{VIEW_MODE_LABELS[mode]}</span>}
            </button>
          );
          return enabled ? (
            button
          ) : (
            <Tooltip key={mode} label={insightUnavailableReason(instance.config.agent)}>
              {button}
            </Tooltip>
          );
        })}
      </div>
    </Tooltip>
  );
}
