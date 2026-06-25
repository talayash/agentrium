import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { captureClaudeInput } from './terminalInput';

/**
 * Build a minimal fake xterm Terminal whose active buffer is `rows` (absolute
 * indices, baseY = 0). Only the surface captureClaudeInput touches is faked.
 */
function makeTerm(
  rows: string[],
  opts: { cursorX?: number; cursorY?: number; dimRows?: number[] } = {},
): Terminal {
  const { cursorX = 0, cursorY = rows.length - 1, dimRows = [] } = opts;
  const dim = new Set(dimRows);
  const getLine = (i: number) => {
    if (i < 0 || i >= rows.length) return undefined;
    return {
      translateToString: () => rows[i],
      getCell: () => ({ isDim: () => dim.has(i) }),
    };
  };
  return {
    rows: rows.length,
    buffer: { active: { baseY: 0, cursorX, cursorY, getLine } },
  } as unknown as Terminal;
}

describe('captureClaudeInput', () => {
  it('extracts text from a boxed Claude prompt row', () => {
    const term = makeTerm(['╭────────╮', '│ > fix the bug │', '╰────────╯']);
    expect(captureClaudeInput(term)).toBe('fix the bug');
  });

  it('extracts text from an un-boxed prompt', () => {
    const term = makeTerm(['> just some text']);
    expect(captureClaudeInput(term)).toBe('just some text');
  });

  it('supports the ❯ prompt glyph', () => {
    const term = makeTerm(['│ ❯ run the tests │']);
    expect(captureClaudeInput(term)).toBe('run the tests');
  });

  it('returns empty for an empty prompt', () => {
    const term = makeTerm(['│ >            │'], { cursorX: 4, cursorY: 0 });
    expect(captureClaudeInput(term)).toBe('');
  });

  it('skips the dimmed placeholder hint', () => {
    // Cursor parked off the prompt row (hidden), placeholder is dimmed.
    const term = makeTerm(
      ['some output', '│ > Try "fix the auth bug" │'],
      { cursorX: 0, cursorY: 0, dimRows: [1] },
    );
    expect(captureClaudeInput(term)).toBe('');
  });

  it('scans upward to find the prompt when the cursor is elsewhere', () => {
    const term = makeTerm(
      ['output line', 'more output', '│ > my prompt │'],
      { cursorX: 0, cursorY: 1 },
    );
    expect(captureClaudeInput(term)).toBe('my prompt');
  });

  it('captures all rows of a multi-line boxed prompt, stripping the indent', () => {
    const term = makeTerm(
      [
        '╭──────────────────────────╮',
        '│ > first line of prompt    │',
        '│   second line continues   │',
        '│   third line here         │',
        '╰──────────────────────────╯',
      ],
      { cursorX: 0, cursorY: 4 },
    );
    expect(captureClaudeInput(term)).toBe(
      'first line of prompt\nsecond line continues\nthird line here',
    );
  });

  it('preserves an interior blank line but trims trailing padding rows', () => {
    const term = makeTerm(
      [
        '│ > paragraph one        │',
        '│                        │',
        '│   paragraph two        │',
        '│                        │',
        '╰────────────────────────╯',
      ],
      { cursorX: 0, cursorY: 4 },
    );
    expect(captureClaudeInput(term)).toBe('paragraph one\n\nparagraph two');
  });

  it('reads the multi-line prompt even when the cursor is on a continuation row', () => {
    const term = makeTerm(
      ['│ > line one      │', '│   line two      │', '╰─────────────────╯'],
      { cursorX: 5, cursorY: 1 },
    );
    expect(captureClaudeInput(term)).toBe('line one\nline two');
  });

  it('strips trailing box border and padding', () => {
    const term = makeTerm(['│ > hello world        │']);
    expect(captureClaudeInput(term)).toBe('hello world');
  });

  it('falls back to pre-cursor text when no marker is recognized', () => {
    const term = makeTerm(['partial prompt text'], { cursorX: 15, cursorY: 0 });
    expect(captureClaudeInput(term)).toBe('partial prompt');
  });

  it('returns empty (no throw) when the buffer is unreadable', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const term = makeTerm(['nothing here'], { cursorX: 0, cursorY: 0 });
    expect(captureClaudeInput(term)).toBe('');
  });
});
