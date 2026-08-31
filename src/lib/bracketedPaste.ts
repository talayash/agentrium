// Bracketed paste (DEC 2004) for text we write straight to the PTY.
//
// xterm.js wraps clipboard pastes in ESC[200~ ... ESC[201~ before handing them
// to `onData`, which is how the agent tells "this is a paste" apart from "the
// user pressed Enter". Any code path that calls `writeToTerminal` with
// clipboard-shaped content has to do the same wrapping itself, or every
// embedded newline arrives as a literal Enter: the agent submits each fragment
// and repaints its input frame on every one, which is what produces the
// screenful of box rules users report as "-----".
//
// Windows adds a second trap: the clipboard hands back \r\n, and xterm's native
// path normalizes that to a single line break while a raw write does not, so
// each pasted line also picks up a stray line feed.
//
// Use this for right-click Paste, snippet insertion, the prompt editor - any
// multi-line payload. Single control bytes (\x03, \x16, \x1f) must NOT go
// through here; they are keypresses, not pastes.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Normalize line endings to LF, neutralize any embedded paste markers, and wrap
 * the result for the terminal. Returns `''` for empty input so callers never
 * send bare markers with no payload.
 */
export function toBracketedPaste(text: string): string {
  // Strip markers the payload already carries. Besides making the function
  // idempotent, this stops a clipboard payload containing ESC[201~ from
  // closing the paste early and letting its remainder run as typed input.
  const stripped = text.split(PASTE_START).join('').split(PASTE_END).join('');
  if (stripped === '') return '';
  const normalized = stripped.replace(/\r\n?/g, '\n');
  return `${PASTE_START}${normalized}${PASTE_END}`;
}
