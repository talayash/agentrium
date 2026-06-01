// Pure decision logic for grid-mode pane navigation, extracted from
// TerminalGrid so it can be unit-tested without rendering xterm in jsdom.

export interface GridNavKey {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  key: string;
  code: string;
}

const ARROWS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']);

/**
 * Decide which grid pane an Alt+navigation key targets.
 *
 * Returns the target pane index, or `null` when the grid should NOT handle the
 * event - in which case it passes through to the focused terminal. Navigation
 * is gated behind a *bare* Alt (no Ctrl/Meta), so unmodified arrow keys still
 * reach the terminal (shell history, cursor, vim). This is the fix for the old
 * collision where bare arrows were double-handled by the grid AND the PTY.
 *
 * - Alt + Arrow: spatial move from `current` (clamped to the grid).
 * - Alt + 1..N: jump straight to that pane, regardless of current focus.
 * - First Alt+Arrow with nothing focused selects the first pane.
 */
export function computeGridNavTarget(
  e: GridNavKey,
  current: number | null,
  cols: number,
  count: number,
): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (count <= 0) return null;

  // Alt+1..N jumps to a pane regardless of current focus.
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    return n - 1;
  }

  if (!ARROWS.has(e.key)) return null;

  // Nothing focused yet: the first navigation selects the first pane.
  if (current === null) return 0;

  switch (e.key) {
    case 'ArrowRight': return Math.min(current + 1, count - 1);
    case 'ArrowLeft': return Math.max(current - 1, 0);
    case 'ArrowDown': return Math.min(current + cols, count - 1);
    case 'ArrowUp': return Math.max(current - cols, 0);
    default: return null;
  }
}
