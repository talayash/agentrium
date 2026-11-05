import { useTerminalStore } from '../store/terminalStore';
import { viewModeOf } from './viewMode';

/** True when the insight toggle applies to this terminal: plain agent
 *  sessions only, never shell terminals or script children. Interim shim,
 *  replaced by the view mode switcher. */
export function insightToggleApplies(id: string | null | undefined): boolean {
  if (!id) return false;
  const instance = useTerminalStore.getState().terminals.get(id);
  return !!instance && !instance.isShellTerminal && !instance.scriptParentId;
}

/** Flip one terminal between CLI and Mixed. Shared by the header button, the
 *  Command Palette entry and the Ctrl+Shift+L shortcut. Failures are toasted
 *  and reported by `setViewMode`. */
export function toggleInsightLayer(id: string): void {
  if (!insightToggleApplies(id)) return;
  const { terminals, setViewMode } = useTerminalStore.getState();
  const current = viewModeOf(terminals.get(id)!.config);
  void setViewMode(id, current === 'cli' ? 'mixed' : 'cli');
}
