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
export function ViewModeSwitch({ terminalId }: { terminalId: string }) {
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  const setViewMode = useTerminalStore((s) => s.setViewMode);
  if (!instance) return null;
  const available = availableViewModes(instance);
  if (available.length < 2) return null;
  const current = effectiveViewMode(instance);
  return (
    <Tooltip label="View mode" shortcut={CYCLE_SHORTCUT}>
      <div
        role="radiogroup"
        aria-label="View mode"
        aria-keyshortcuts="Control+Shift+L"
        className="flex items-center h-7 p-0.5 gap-0.5 rounded-lg bg-fill-subtle ring-1 ring-inset ring-seam"
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
              onClick={() => {
                if (enabled && !checked) void setViewMode(terminalId, mode);
              }}
              className={`flex items-center gap-1 h-6 px-2 rounded-lg text-[11.5px] font-medium transition-colors ${
                checked
                  ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30'
                  : enabled
                    ? 'text-text-secondary hover:text-text-primary hover:bg-fill-hover'
                    : 'text-text-secondary/40 cursor-not-allowed'
              }`}
            >
              <Icon size={13} strokeWidth={1.75} />
              <span className="hidden sm:inline">{VIEW_MODE_LABELS[mode]}</span>
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
