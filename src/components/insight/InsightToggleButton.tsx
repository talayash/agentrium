import { Layers } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { toggleInsightLayer } from '../../lib/insightToggle';
import { Tooltip } from '../ui/Tooltip';

/** Session header toggle for the insight layer. Hidden for shell terminals
 *  and script children, where the layer never applies. */
export function InsightToggleButton({ terminalId }: { terminalId: string }) {
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  if (!instance || instance.isShellTerminal || instance.scriptParentId) return null;
  const on = !!instance.config.insight_layer;
  return (
    <Tooltip label="Toggle insight layer" shortcut="Ctrl+Shift+L">
      <button
        aria-label="Insight layer"
        aria-pressed={on}
        aria-keyshortcuts="Control+Shift+L"
        onClick={() => toggleInsightLayer(terminalId)}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium transition-colors ${
          on
            ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25'
            : 'hover:bg-fill-hover text-text-secondary hover:text-text-primary'
        }`}
      >
        <Layers size={13} strokeWidth={1.75} />
        <span className="hidden sm:inline">Insight</span>
      </button>
    </Tooltip>
  );
}
