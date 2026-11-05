import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { captureClaudeInput } from './terminalInput';
import { toBracketedPaste, PASTE_START, PASTE_END } from './bracketedPaste';

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

export { PASTE_START, PASTE_END };

/**
 * Keys that submit a prompt. Multiline text goes as one bracketed paste (markers
 * stripped by toBracketedPaste) then Enter. Single-line text has ESC and other
 * C0 control characters (except tab) removed, so it can never inject keys.
 */
export function buildPromptKeys(text: string): string[] {
  const t = text.replace(/\r\n?/g, '\n').trimEnd();
  if (t.trim() === '') return [];
  if (t.includes('\n')) {
    const paste = toBracketedPaste(t);
    return paste === '' ? [] : [paste, '\r'];
  }
  // eslint-disable-next-line no-control-regex
  const clean = t.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
  if (clean.trim() === '') return [];
  return [clean, '\r'];
}

export function sendPrompt(terminalId: string, text: string): Promise<void> {
  const keys = buildPromptKeys(text);
  if (keys.length === 0) return Promise.resolve();
  return useTerminalStore.getState().sendKeySequence(terminalId, keys);
}

export function interruptAgent(terminalId: string): Promise<void> {
  return useTerminalStore.getState().sendKeySequence(terminalId, ['\x1b']);
}
