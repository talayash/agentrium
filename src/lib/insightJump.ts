import type { Terminal } from '@xterm/xterm';

/** Scans the active buffer bottom-up for the first line containing `needle`. Returns the absolute line or null. */
export function findLineInBuffer(xterm: Terminal, needle: string): number | null {
  const text = needle.trim();
  if (!text) return null;
  const buf = xterm.buffer.active;
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i);
    if (line && line.translateToString(true).includes(text)) return i;
  }
  return null;
}
