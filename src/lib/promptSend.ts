import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { captureClaudeInput } from './terminalInput';
import { toBracketedPaste } from './bracketedPaste';

/**
 * Make the terminal's input line hold exactly `text`, then optionally submit
 * it. Shared by the prompt editor and Race mode's "Send to all waiting".
 *
 * A full replace, not an append: re-capture the live input and clear it with
 * Ctrl+U before writing. Ctrl+U on an empty line no-ops, so a few extra are
 * sent past the captured line count; this guards against under-counting (a
 * line we failed to scrape) which would otherwise leave a remnant. Over-
 * counting is always harmless.
 */
export async function writePromptToTerminal(terminalId: string, text: string, submit: boolean): Promise<void> {
  const { terminals, writeToTerminal } = useTerminalStore.getState();
  const xterm = terminals.get(terminalId)?.xterm;
  const current = xterm ? captureClaudeInput(xterm) : '';
  const clearCount = Math.max(1, current.split('\n').length) + 3;
  await writeToTerminal(terminalId, '\x15'.repeat(clearCount));
  await writeToTerminal(terminalId, toBracketedPaste(text));
  if (submit) {
    // The prompt is submitted and consumed, so drop the draft: the next
    // editor open starts fresh.
    await writeToTerminal(terminalId, '\r');
    useAppStore.getState().clearPromptDraft(terminalId);
  }
}

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Keys that submit a prompt: plain text + Enter, or one bracketed paste + Enter when multiline. */
export function buildPromptKeys(text: string): string[] {
  const t = text.trimEnd();
  if (t.trim() === '') return [];
  if (t.includes('\n')) return [PASTE_START + t + PASTE_END, '\r'];
  return [t, '\r'];
}

export function sendPrompt(terminalId: string, text: string): Promise<void> {
  const keys = buildPromptKeys(text);
  if (keys.length === 0) return Promise.resolve();
  return useTerminalStore.getState().sendKeySequence(terminalId, keys);
}

export function interruptAgent(terminalId: string): Promise<void> {
  return useTerminalStore.getState().sendKeySequence(terminalId, ['\x1b']);
}
