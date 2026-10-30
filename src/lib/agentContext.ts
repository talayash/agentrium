// Staging context (a picked page element, a diff, a note) for an agent
// session. Context only ever reaches an agent through the prompt editor,
// where the user reads and sends it; it is never typed into the PTY.

import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

/** The active terminal when it is an agent session (not a shell or script tab). */
export function stageTarget(): string | null {
  const { activeTerminalId, terminals } = useTerminalStore.getState();
  if (!activeTerminalId) return null;
  const t = terminals.get(activeTerminalId);
  if (!t || t.isShellTerminal || t.scriptName || t.scriptParentId) return null;
  return activeTerminalId;
}

/** Append `block` to the session's prompt draft and open the editor on it. */
export function stageForAgent(terminalId: string, block: string): void {
  const app = useAppStore.getState();
  const draft = app.promptDrafts[terminalId] ?? '';
  const text = draft.trim() ? `${draft.trimEnd()}\n\n${block}` : block;
  app.setPromptDraft(terminalId, text);
  app.openPromptEditor(terminalId, text);
}
