import { useTerminalStore } from '../store/terminalStore';

/** True when the insight layer toggle applies to this terminal: plain agent
 *  sessions only, never shell terminals or script children. */
export function insightToggleApplies(id: string | null | undefined): boolean {
  if (!id) return false;
  const instance = useTerminalStore.getState().terminals.get(id);
  return !!instance && !instance.isShellTerminal && !instance.scriptParentId;
}

/** Flip the insight layer for one terminal. Shared by the status bar button,
 *  the Command Palette entry and the Ctrl+Shift+L shortcut. Failures are
 *  toasted and reported by `setInsightLayer`. */
export function toggleInsightLayer(id: string): void {
  if (!insightToggleApplies(id)) return;
  const { terminals, setInsightLayer } = useTerminalStore.getState();
  const current = !!terminals.get(id)?.config.insight_layer;
  void setInsightLayer(id, !current);
}
