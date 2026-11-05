import { useInsightStore } from '../store/insightStore';
import { useTerminalStore } from '../store/terminalStore';
import { effectiveViewMode } from './viewMode';

/** What a mounted prompt bar exposes to code outside its component tree. */
export interface PromptBarTarget {
  focus: () => void;
  /** Append text to the draft (space-separated) and focus the bar. */
  insertText: (text: string) => void;
}

const bars = new Map<string, PromptBarTarget>();

/** Register a terminal's prompt bar; returns the unregister function. */
export function registerPromptBar(terminalId: string, target: PromptBarTarget): () => void {
  bars.set(terminalId, target);
  return () => {
    if (bars.get(terminalId) === target) bars.delete(terminalId);
  };
}

export function promptBarFor(terminalId: string): PromptBarTarget | undefined {
  return bars.get(terminalId);
}

/** True when keyboard input for this terminal belongs in its prompt bar:
 *  the session is in Insight mode and the terminal drawer is closed. */
export function inputGoesToPromptBar(terminalId: string): boolean {
  const instance = useTerminalStore.getState().terminals.get(terminalId);
  if (!instance?.config || effectiveViewMode(instance) !== 'insight') return false;
  return useInsightStore.getState().byId.get(terminalId)?.drawerOpen !== true;
}

/** Focus where the user types for this session: the prompt bar in Insight
 *  mode with the drawer closed, otherwise the xterm. Never focuses the
 *  hidden PTY of an Insight-mode session. */
export function focusTerminalInput(terminalId: string): void {
  if (inputGoesToPromptBar(terminalId)) {
    bars.get(terminalId)?.focus();
    return;
  }
  useTerminalStore.getState().terminals.get(terminalId)?.xterm?.focus();
}
