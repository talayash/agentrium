// Decides whether an xterm.js input event should be forwarded straight to the
// PTY or intercepted with a "large paste detected" warning. Extracted from
// TerminalView so the branching is unit-testable without an xterm instance.

export interface PasteWarningInput {
  /** The raw string xterm.js delivered to `onData`. */
  data: string;
  /**
   * Milliseconds since the previous `onData` event on this terminal. Pass
   * `Number.POSITIVE_INFINITY` when there is no prior event so the very first
   * input is treated as a potential paste rather than as interactive typing.
   */
  msSinceLastInput: number;
  /** User setting: is paste auto-detection turned on for this app instance. */
  autoDetectEnabled: boolean;
  /** User setting: warn when the paste is at least this many bytes. */
  thresholdBytes: number;
  /** User setting: warn when the paste is at least this many lines. */
  thresholdLines: number;
}

export interface PasteWarningVerdict {
  action: 'forward' | 'warn';
  bytes: number;
  lines: number;
}

const PASTE_HEURISTIC_MIN_LENGTH = 64;
const PASTE_HEURISTIC_MIN_GAP_MS = 16;

export function classifyPasteInput(input: PasteWarningInput): PasteWarningVerdict {
  const bytes = new TextEncoder().encode(input.data).length;
  const lines = input.data.split('\n').length;

  const isLikelyPaste =
    input.data.length > PASTE_HEURISTIC_MIN_LENGTH &&
    input.msSinceLastInput > PASTE_HEURISTIC_MIN_GAP_MS;

  if (!isLikelyPaste || !input.autoDetectEnabled) {
    return { action: 'forward', bytes, lines };
  }
  if (bytes < input.thresholdBytes && lines < input.thresholdLines) {
    return { action: 'forward', bytes, lines };
  }
  return { action: 'warn', bytes, lines };
}
