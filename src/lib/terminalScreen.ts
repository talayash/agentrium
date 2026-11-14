import type { IBufferLine } from '@xterm/xterm';
import type { Terminal } from '@xterm/xterm';
import type { AskQuestion } from './insightModel';
import { useTerminalStore } from '../store/terminalStore';

/** The parts of an xterm Terminal the screen reader needs. */
export interface ScreenSource {
  rows: number;
  buffer: { active: { baseY: number; length: number; getLine: (y: number) => IBufferLine | undefined } };
}

/** A row that is only a horizontal rule. Claude Code draws its input-box rules
 *  exactly as wide as the terminal, so xterm flags the next row (the `❯` prompt,
 *  the footer) as wrapped even though it is a separate line. Never join onto one. */
const RULE_ONLY = /^\s*[─━═-]+\s*$/;

const screens = new WeakMap<ScreenSource, { lines?: string[] }>();

/** Cache only terminals whose parser/resize lifecycle we can observe. */
export function trackTerminalScreen(term: Terminal): () => void {
  const cache: { lines?: string[] } = {};
  screens.set(term, cache);
  const invalidate = () => { cache.lines = undefined; };
  const subscriptions = [term.onWriteParsed(invalidate), term.onResize(invalidate)];
  return () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    screens.delete(term);
  };
}

/**
 * Read what the terminal is showing as clean logical lines, newest last.
 *
 * Reads the SCREEN (rows `baseY` .. `baseY + rows - 1`), never the scroll
 * position: a user who scrolled up must not change detection, and a TUI in the
 * alternate buffer that draws at the top of a tall screen must still be seen.
 * Wrapped rows are joined to the row they continue, then blank lines are
 * dropped and only the last `maxLines` non-blank logical lines are kept.
 */
export function readBufferTail(term: ScreenSource, maxLines: number): string[] {
  const cache = screens.get(term);
  if (cache?.lines) return cache.lines.slice(Math.max(0, cache.lines.length - maxLines));
  const buf = term.buffer.active;
  const start = Math.max(0, buf.baseY);
  const end = Math.min(buf.length, start + term.rows);
  const logical: string[] = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    const text = line ? line.translateToString(true) : '';
    const prev = logical[logical.length - 1];
    if (line?.isWrapped && prev !== undefined && !RULE_ONLY.test(prev)) logical[logical.length - 1] += text;
    else logical.push(text);
  }
  const nonBlank = logical.filter((l) => l.trim() !== '');
  if (cache) cache.lines = nonBlank;
  return nonBlank.slice(Math.max(0, nonBlank.length - maxLines));
}

const MATCH_PREFIX = 40;
const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();

/** True when the terminal's screen still shows this question (or its header).
 *  Guards against sending answer keys for a question that is long gone. */
export function questionOnScreen(terminalId: string, q: AskQuestion | undefined): boolean {
  const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
  if (!xterm || !q) return false;
  const screenText = collapse(readBufferTail(xterm, Number.POSITIVE_INFINITY).join(' '));
  const needle = collapse(q.question).slice(0, MATCH_PREFIX);
  const header = collapse(q.header);
  return (needle !== '' && screenText.includes(needle)) || (header !== '' && screenText.includes(header));
}
