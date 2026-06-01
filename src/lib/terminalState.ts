/** Inferred state of a Claude Code terminal. */
export type SessionState = 'busy' | 'waiting' | 'idle' | 'stopped';

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
];

/**
 * Markers that mean the plain input box is on screen — i.e. Claude is idle and
 * ready for a new prompt, even if a numbered list from the last response is
 * still visible above the box.
 */
const IDLE_MARKERS: RegExp[] = [
  /\?\s+for\s+shortcuts/i,
  /^[│|]?\s*>\s*$/,
];

/** A selectable option line, e.g. "❯ 1. Yes" or "2. No". */
const OPTION_LINE = /^(?:❯\s*)?\d+\.\s+\S/;

/**
 * Decide whether settled terminal output represents a blocking prompt
 * (`waiting`) or a ready input box (`idle`). Only called once output has gone
 * quiet — `busy` is handled by the caller via the activity timer.
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
  if (IDLE_MARKERS.some((re) => trimmed.some((l) => re.test(l)))) return 'idle';

  // 3. A selection menu: two or more option lines AND at least one carries the
  //    `❯` cursor. The cursor distinguishes an interactive picker from a plain
  //    numbered list left in a finished response.
  const optionLines = trimmed.filter((l) => OPTION_LINE.test(l));
  const hasCursor = trimmed.some((l) => /^❯\s*\d+\.\s+\S/.test(l));
  if (optionLines.length >= 2 && hasCursor) return 'waiting';

  return 'idle';
}
