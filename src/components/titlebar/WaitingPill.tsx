import { useMemo } from 'react';
import { useTerminalStore } from '../../store/terminalStore';
import { StateDot } from '../StateDot';
import { Tooltip } from '../ui/Tooltip';

/**
 * Title-bar signal for sessions OTHER than the focused one that are blocked
 * on the user - the one glanceable cue a collapsed or hidden sidebar cannot
 * give. Renders nothing unless something is waiting; clicking jumps to the
 * oldest waiting session. (Replaces the old SessionWidget dropdown, whose
 * switcher duplicated the sidebar's SessionCards.)
 */
export function WaitingPill() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);

  const waiting = useMemo(
    () =>
      Array.from(terminals.values())
        .filter(
          (t) =>
            !t.scriptParentId &&
            !t.isShellTerminal &&
            t.config.id !== activeTerminalId &&
            terminalStates.get(t.config.id) === 'waiting',
        )
        .sort((a, b) => (a.config.created_at < b.config.created_at ? -1 : 1)),
    [terminals, terminalStates, activeTerminalId],
  );

  if (waiting.length === 0) return null;
  const first = waiting[0].config;

  return (
    <Tooltip label={`Go to ${first.nickname || first.label}`}>
      <button
        onClick={() => setActiveTerminal(first.id)}
        aria-label={`${waiting.length} session${waiting.length === 1 ? '' : 's'} waiting for input`}
        className="no-drag flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] font-medium text-[color:var(--attention-input)] bg-[color-mix(in_srgb,var(--attention-input)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--attention-input)_22%,transparent)] transition-colors"
      >
        <StateDot state="waiting" size={6} />
        {waiting.length} waiting
      </button>
    </Tooltip>
  );
}
