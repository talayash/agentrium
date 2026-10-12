import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

/** Opens Learn for a specific terminal. Learn follows the active terminal, so make
 *  the finished one active first (only if it lives in this window's store). */
export function openLearnFor(terminalId: string): void {
  const terminals = useTerminalStore.getState();
  if (terminals.terminals.has(terminalId)) terminals.setActiveTerminal(terminalId);
  useAppStore.getState().openLearn();
}
