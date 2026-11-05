/** Inferred state of a Claude Code terminal. */
export type SessionState = 'busy' | 'waiting' | 'idle' | 'stopped';

/** An input prompt alone isn't a completed turn: it also exists on startup.
 * The caller must additionally have seen a submitted prompt or a finish footer.
 * Never infer completion merely because output paused. */
export function hasReadyPrompt(lines: string[]): boolean {
  if (lines.some((line) => /esc\s+(?:to\s+)?(?:interrupt|cancel|stop)|(?:thinking|working|running)\s*[.…]/i.test(line))) return false;
  return lines.some((line) => /^[│|]?\s*[❯›>]\s*(?:[│|]\s*)?$/.test(line.trim())
    || /^\s*›\s+(?:Ask|Explain|Implement|Find|Write|Improve|Run|Summarize)\b/i.test(line));
}

export function hasTurnFinishedMarker(lines: string[]): boolean {
  return lines.some((line) => /^\s*(?:[✻✽✢✶✳✺·•]\s*)?[A-Za-z]+\s+for\s+\d+(?:[.\d\s]*[smh]|\s+(?:seconds?|minutes?))\b/i.test(line)
    || /^\s*[─━-]*\s*Worked for\s+\d/i.test(line));
}

/**
 * Phrases that unambiguously mean Claude is blocked waiting for a decision.
 * Kept as an exported, versioned list so they are cheap to tune as Claude
 * Code's prompt UI changes. Matched against the joined, trimmed tail text.
 */
export const WAITING_PATTERNS: RegExp[] = [
  /Do you want to proceed\??/i,
  /Do you trust the files in this folder\??/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  // Codex approval prompts (command, edits) and their footer.
  /Would you like to run the following command\??/i,
  /Would you like to make the following edits\??/i,
  /Press enter to confirm or esc to cancel/i,
  // Claude Code folder-trust prompt and its footer (seen in 2.1.318).
  /Is this a project you created or one you trust\??/i,
  /Enter to confirm\s*·\s*Esc to cancel/i,
];

/**
 * Markers that mean the plain input box is on screen - i.e. Claude is idle and
 * ready for a new prompt, even if a numbered list from the last response is
 * still visible above the box.
 */
const IDLE_MARKERS: RegExp[] = [
  /\?\s+for\s+shortcuts/i,
  /^[│|]?\s*[>❯]\s*(?:[│|]\s*)?$/,
];

/** True when Claude's plain input box (or its "? for shortcuts" footer) is on
 *  screen, i.e. the agent is idle and ready for a new prompt. */
function hasIdleMarker(trimmed: string[]): boolean {
  return IDLE_MARKERS.some((re) => trimmed.some((l) => re.test(l)));
}

/** A selectable option line, e.g. "❯ 1. Yes" or "2. No". Codex draws its
 *  cursor as `›` instead of Claude's `❯`. */
const OPTION_LINE = /^(?:[❯›]\s*)?\d+\.\s+\S/;

/** A selection menu: two or more option lines AND at least one carries the
 *  `❯`/`›` cursor. The cursor distinguishes an interactive picker from a plain
 *  numbered list left in a finished response. */
export function hasOptionMenu(lines: string[]): boolean {
  const trimmed = lines.map((l) => l.trim());
  const optionLines = trimmed.filter((l) => OPTION_LINE.test(l));
  const hasCursor = trimmed.some((l) => /^[❯›]\s*\d+\.\s+\S/.test(l));
  return optionLines.length >= 2 && hasCursor;
}

/**
 * Decide whether settled terminal output represents a blocking prompt
 * (`waiting`) or a ready input box (`idle`). Only called once output has gone
 * quiet - `busy` is handled by the caller via the activity timer.
 *
 * Bias: when uncertain, return `idle`. A missed prompt is a minor annoyance;
 * a false "needs attention" alarm erodes trust in the whole feature.
 */
export function classifySettled(lines: string[]): 'waiting' | 'idle' {
  const trimmed = lines.map((l) => l.trim());
  const joined = trimmed.join('\n');

  // 1. Explicit blocking phrases win immediately.
  for (const re of WAITING_PATTERNS) {
    if (re.test(joined)) return 'waiting';
  }

  // 2. If the plain input box is visible, Claude is idle regardless of any
  //    numbered list left over from its last response.
  if (hasIdleMarker(trimmed)) return 'idle';

  // 3. A selection menu: two or more option lines AND at least one carries the
  //    `❯` cursor. The cursor distinguishes an interactive picker from a plain
  //    numbered list left in a finished response.
  if (hasOptionMenu(trimmed)) return 'waiting';

  return 'idle';
}

const SHELL_PROMPTS: RegExp[] = [
  /^[A-Za-z]:\\[^>]*>\s*$/,
  /^PS [A-Za-z]:\\[^>]*>\s*$/,
  /^[^\s@]+@[^\s:]+:[^$#]*[$#]\s*$/,
];

/** True when the last non-empty line is a bare shell prompt (cmd, PowerShell
 *  or POSIX), i.e. the agent has exited back to a shell. */
export function isShellPrompt(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    return SHELL_PROMPTS.some((re) => re.test(lines[i]));
  }
  return false;
}

/** How many of the newest non-blank lines WAITING_PATTERNS are matched against
 *  in needsTerminal. A real prompt sits at the bottom of the screen; text
 *  higher up is usually a reply quoting one of the phrases. */
const NEEDS_TERMINAL_BOTTOM_LINES = 8;

/** Whether the hidden terminal needs the user: a blocking prompt, an option
 *  menu, or a bare shell. Independent of the polled session state. Claude's
 *  idle input box on screen wins (like classifySettled), so a reply that
 *  quotes "Do you want to proceed?" or "(y/n)" never opens the drawer. */
export function needsTerminal(lines: string[], questionPending: boolean): boolean {
  if (questionPending) return false;
  const trimmed = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (hasIdleMarker(trimmed)) return false;
  const bottom = trimmed.slice(-NEEDS_TERMINAL_BOTTOM_LINES).join('\n');
  return hasOptionMenu(trimmed) || WAITING_PATTERNS.some((re) => re.test(bottom)) || isShellPrompt(trimmed);
}
