import type { Terminal } from '@xterm/xterm';

// Prompt glyphs Claude Code (and common shells) use to mark the input line.
const PROMPT_MARKER = /^([>❯➜▶$#]\s+)(\S.*)$/u;
// Leading box border ("│ ") plus the inner content of a row.
const BOX_ROW = /^(\s*[│|]\s?)?(.*)$/u;

/**
 * Best-effort capture of the text the user has already typed into Claude Code's
 * input line, so the Prompt Editor can continue from it instead of starting
 * blank.
 *
 * Claude renders its prompt inside a box. The first row carries the marker and
 * the rest are indented continuation rows:
 *
 *   ╭───────────────────────────────╮
 *   │ > first line of the prompt     │
 *   │   second line continues        │
 *   ╰───────────────────────────────╯
 *
 * We can't rely on the terminal's hardware cursor (TUIs hide it and draw their
 * own), so we scan the bottom of the viewport for the marker row, then walk
 * downward collecting continuation rows until the box border ends, stripping
 * the decoration and the alignment indent. Rows are joined with newlines.
 *
 * Limitation: soft-wrapped long lines are indistinguishable from genuine line
 * breaks, so a single long line that wrapped in the terminal comes back split
 * at the wrap points. As a seed for further editing that's acceptable.
 */
export function captureClaudeInput(term: Terminal): string {
  try {
    const buf = term.buffer.active;

    // Parse a row into its leading box decoration and inner content (trailing
    // border + padding removed).
    const split = (i: number): { hasBorder: boolean; deco: string; content: string } | null => {
      const ln = buf.getLine(i);
      if (!ln) return null;
      const r = ln.translateToString(false).replace(/\s*[│|]?\s*$/u, '');
      const m = r.match(BOX_ROW);
      if (!m) return null;
      const deco = m[1] ?? '';
      return { hasBorder: /[│|]/u.test(deco), deco, content: m[2] ?? '' };
    };

    const isDim = (row: number, col: number): boolean => {
      const cell = buf.getLine(row)?.getCell(col);
      return !!(cell && cell.isDim());
    };

    // Read a (possibly multi-line) prompt whose first row is `i`, or null if
    // row `i` is not a prompt marker row.
    const readFrom = (i: number): string | null => {
      const head = split(i);
      if (!head) return null;
      const mm = head.content.match(PROMPT_MARKER);
      if (!mm) return null;
      const markerWidth = mm[1].length;
      // Placeholder guard: the empty-state hint is rendered dimmed.
      if (isDim(i, head.deco.length + markerWidth)) return null;

      const lines = [mm[2].replace(/\s+$/u, '')];
      // Collect continuation rows: inner box rows below the marker row, until
      // the bottom border (a row without the "│" left border) ends the box.
      const stripIndent = new RegExp(`^\\s{0,${markerWidth}}`, 'u');
      for (let j = i + 1; j < i + 40; j++) {
        const row = split(j);
        if (!row || !row.hasBorder) break;
        lines.push(row.content.replace(stripIndent, '').replace(/\s+$/u, ''));
      }
      // Trim trailing blank rows (box padding); keep interior blank lines.
      while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    };

    // Prefer the cursor row, then scan the visible rows bottom-up. Scanning
    // upward naturally lands on the marker row even when the cursor sits on a
    // continuation row (continuation rows have no marker, so readFrom skips
    // them).
    const cursorRow = buf.baseY + buf.cursorY;
    const fromCursor = readFrom(cursorRow);
    if (fromCursor && fromCursor.trim()) return fromCursor;

    const bottom = buf.baseY + term.rows - 1;
    const top = Math.max(0, bottom - 40);
    for (let k = bottom; k >= top; k--) {
      const r = readFrom(k);
      if (r && r.trim()) return r;
    }

    // Last resort: whatever sits before the cursor on its row, decoration
    // stripped. Covers builds whose prompt glyph we don't recognize.
    const ln = buf.getLine(cursorRow);
    if (ln) {
      const pre = ln
        .translateToString(false)
        .slice(0, buf.cursorX)
        .replace(/^\s*(?:[│|]\s*)?[>❯➜▶$#]?\s*/u, '')
        .trimEnd();
      if (pre.trim()) return pre;
    }

    if (import.meta.env.DEV) {
      const dump: Record<number, string> = {};
      for (let i = bottom; i >= top; i--) {
        dump[i] = buf.getLine(i)?.translateToString(false) ?? '';
      }
      // eslint-disable-next-line no-console
      console.debug('[captureClaudeInput] no match', {
        baseY: buf.baseY, cursorX: buf.cursorX, cursorY: buf.cursorY, rows: dump,
      });
    }
    return '';
  } catch {
    return '';
  }
}
