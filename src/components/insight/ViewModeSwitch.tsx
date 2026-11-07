import { useLayoutEffect, useRef, useState } from 'react';
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
 *  drive stay visible but disabled. Styled as a segmented control: a raised
 *  neutral thumb slides under the active mode (`.view-switch*` in index.css). */
export function ViewModeSwitch({ terminalId, compact = false }: { terminalId: string; compact?: boolean }) {
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  const setViewMode = useTerminalStore((s) => s.setViewMode);
  const thumbRef = useRef<HTMLSpanElement>(null);
  // The thumb stays invisible and un-animated until its first placement, so
  // it never slides in from the left edge on mount.
  const [placed, setPlaced] = useState(false);

  const available = instance ? availableViewModes(instance) : [];
  const current = instance ? effectiveViewMode(instance) : null;
  const availableKey = available.join(',');

  // Measured, not computed: segment widths depend on the label text, the
  // font and the `sm:` breakpoint that hides labels, so the thumb follows the
  // checked segment's real box and re-measures whenever the group resizes.
  useLayoutEffect(() => {
    const thumb = thumbRef.current;
    const group = thumb?.parentElement;
    if (!thumb || !group) return;
    const place = () => {
      const seg = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      if (!seg) return;
      thumb.style.left = `${seg.offsetLeft}px`;
      thumb.style.width = `${seg.offsetWidth}px`;
      setPlaced(true);
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(group);
    return () => ro.disconnect();
  }, [current, availableKey]);

  if (!instance || available.length < 2) return null;
  return (
    // Both forms show each mode's name, so the tooltip only names the group.
    <Tooltip label="View mode" shortcut={CYCLE_SHORTCUT}>
      <div
        role="radiogroup"
        aria-label="View mode"
        aria-keyshortcuts="Control+Shift+L"
        className={`view-switch no-drag ${compact ? 'h-[26px]' : 'h-7'}`}
      >
        <span ref={thumbRef} aria-hidden="true" className="view-switch-thumb" data-placed={placed} />
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
              className={`view-switch-seg ${compact ? 'h-[22px] px-2 text-[11px]' : 'h-6 px-2.5 text-[11.5px]'}`}
            >
              <Icon size={13} strokeWidth={1.75} />
              {/* Tiny label so the mode reads at a glance; dropped on very
                  narrow windows where the toolbar has no room for it. */}
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
