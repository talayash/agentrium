import type { Terminal } from '@xterm/xterm';

// Prompt glyphs Claude Code (and common shells) use to mark the input line.
// Matched after an optional box border ("│ ") and surrounding whitespace.
const PROMPT_ROW = /^\s*(?:[│|]\s*)?[>❯➜▶$#]\s+(\S.*)$/u;

/**
 * Best-effort capture of the text the user has already typed into Claude Code's
 * input line, so the Prompt Editor can continue from it instead of starting
 * blank.
 *
 * Claude renders its prompt inside a box: `│ > the typed text            │`.
 * We can't rely on the terminal's hardware cursor (TUIs frequently hide it and
 * draw their own), so instead we scan the bottom of the viewport for the row
 * that looks like the prompt line and pull the text out of it, stripping the
 * box decoration. The dimmed empty-state placeholder is skipped via its faint
 * attribute.
 *
 * Limitations: only the first prompt row is read, so a prompt already wrapped
 * across multiple visual lines in the terminal yields just its first line.
 */
export function captureClaudeInput(term: Terminal): string {
  try {
    const buf = term.buffer.active;

    const tryRow = (i: number): string | null => {
      const ln = buf.getLine(i);
      if (!ln) return null;
      // Drop the trailing box border + padding so the regex sees clean text.
      const s = ln.translateToString(false).replace(/\s*[│|]?\s*$/u, '');
      const m = s.match(PROMPT_ROW);
      if (!m) return null;
      const inner = m[1];
      if (!inner.trim()) return null;
      // Placeholder guard: the empty-state hint is rendered dimmed. Check the
      // attribute of the first inner character.
      const startCol = s.length - inner.length;
      const cell = ln.getCell(startCol);
      if (cell && cell.isDim()) return null;
      return inner.trimEnd();
    };

    // Prefer the row the cursor is on, then scan the visible rows bottom-up.
    const cursorRow = buf.baseY + buf.cursorY;
    const fromCursor = tryRow(cursorRow);
    if (fromCursor) return fromCursor;

    const bottom = buf.baseY + term.rows - 1;
    const top = Math.max(0, bottom - 24);
    for (let i = bottom; i >= top; i--) {
      const r = tryRow(i);
      if (r) return r;
    }

    // Last resort: take whatever sits before the cursor on its row, stripping
    // any leading box/prompt decoration. Covers Claude builds whose prompt
    // glyph we don't recognize above.
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
      // Diagnostic to converge quickly if capture still misses: dump the rows
      // we inspected so they can be shared from the devtools console.
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
