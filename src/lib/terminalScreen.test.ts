import { describe, expect, it, vi } from 'vitest';
import { questionOnScreen, readBufferTail, trackTerminalScreen, type ScreenSource } from './terminalScreen';
import { useTerminalStore } from '../store/terminalStore';
import { classifySettled, hasReadyPrompt, hasTurnFinishedMarker, needsTerminal } from './terminalState';
import { ASK_USER_QUESTION_SCREEN } from './__fixtures__/askUserQuestionScreen';

const ROWS = 35;

it('reuses unchanged screens across consumers and invalidates after parsing or resizing', () => {
  const lines = ['ready'];
  const source = term(lines);
  const getLine = vi.spyOn(source.buffer.active, 'getLine');
  let parsed!: () => void;
  let resized!: () => void;
  const dispose = vi.fn();
  const stop = trackTerminalScreen(Object.assign(source, {
    onWriteParsed: (fn: () => void) => { parsed = fn; return { dispose }; },
    onResize: (fn: () => void) => { resized = fn; return { dispose }; },
  }) as never);
  expect(readBufferTail(source, 15)).toEqual(['ready']);
  expect(readBufferTail(source, Infinity)).toEqual(['ready']);
  expect(getLine).toHaveBeenCalledTimes(1);
  lines[0] = 'waiting';
  parsed();
  expect(readBufferTail(source, 15)).toEqual(['waiting']);
  resized();
  readBufferTail(source, 15);
  expect(getLine).toHaveBeenCalledTimes(3);
  stop();
  expect(dispose).toHaveBeenCalledTimes(2);
  lines[0] = 'after disposal';
  expect(readBufferTail(source, 15)).toEqual(['after disposal']);
});

/** A fake xterm whose screen starts at `baseY`. Rows listed in `wrapped`
 *  continue the row above them (xterm's `isWrapped`). */
function term(lines: string[], opts: { baseY?: number; viewportY?: number; wrapped?: number[] } = {}): ScreenSource {
  return {
    rows: ROWS,
    buffer: {
      active: {
        baseY: opts.baseY ?? 0,
        viewportY: opts.viewportY ?? opts.baseY ?? 0,
        length: lines.length,
        getLine: (y: number) => (y < lines.length
          ? { isWrapped: opts.wrapped?.includes(y) ?? false, translateToString: () => lines[y]! }
          : undefined) as never,
      },
    } as ScreenSource['buffer'],
  };
}

/** A 35-row alternate-buffer screen with `content` drawn from row `top`. */
function screen(content: string[], top = 0): string[] {
  const rows = Array.from({ length: ROWS }, () => '');
  content.forEach((l, i) => { rows[top + i] = l; });
  return rows;
}

// Claude Code's folder-trust prompt, drawn at the top of a fresh alternate screen.
const TRUST_SCREEN = screen([
  ' Accessing workspace:',
  '',
  ' C:\\Users\\tal\\proj',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
  ' open source project, or work from your team). If not, take a moment to review what is in this folder.',
  '',
  ' Claude Code will be able to read, edit, and execute files here.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
]);

describe('readBufferTail reads the screen', () => {
  it('sees a prompt drawn at the top of a 35-row alternate screen', () => {
    const lines = readBufferTail(term(TRUST_SCREEN), 15);
    expect(lines[0]).toBe(' Accessing workspace:');
    expect(lines.at(-1)).toBe(' Enter to confirm · Esc to cancel');
    expect(needsTerminal(lines, false)).toBe(true);
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('sees the AskUserQuestion menu in rows 9-23 of 35', () => {
    const lines = readBufferTail(term(screen(ASK_USER_QUESTION_SCREEN, 9)), 15);
    expect(needsTerminal(lines, false)).toBe(true);
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('a scrolled-up viewport reads the same screen as an unscrolled one', () => {
    const history = Array.from({ length: 100 }, (_, i) => `old output ${i}`);
    const all = [...history, ...screen(ASK_USER_QUESTION_SCREEN, 9)];
    const unscrolled = readBufferTail(term(all, { baseY: 100 }), 15);
    const scrolled = readBufferTail(term(all, { baseY: 100, viewportY: 20 }), 15);
    expect(scrolled).toEqual(unscrolled);
    expect(scrolled.some((l) => l.startsWith('old output'))).toBe(false);
    expect(classifySettled(scrolled)).toBe('waiting');
  });

  it('joins wrapped rows and keeps only the last N non-blank logical lines', () => {
    const lines = readBufferTail(term(screen(['a', '', 'Do you want', ' to proceed?', 'b', '', 'c']), { wrapped: [3] }), 3);
    expect(lines).toEqual(['Do you want to proceed?', 'b', 'c']);
  });

  // Claude Code 2.1.319 draws its input-box rules exactly as wide as the
  // terminal, so xterm flags the row after each rule as wrapped. Joining them
  // hid the bare `❯` prompt and a finished turn never counted as completed.
  it('does not glue the input prompt onto a full-width rule flagged as wrapped', () => {
    const rule = '─'.repeat(133);
    const lines = readBufferTail(term(screen([
      '● OK',
      '✻ Crunched for 3s · done 2:16 PM',
      rule,
      '❯ ',
      rule,
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]), { wrapped: [3, 5] }), 15);
    expect(lines).toEqual([
      '● OK',
      '✻ Crunched for 3s · done 2:16 PM',
      rule,
      '❯ ',
      rule,
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]);
    expect(hasReadyPrompt(lines)).toBe(true);
    expect(hasTurnFinishedMarker(lines)).toBe(true);
    expect(classifySettled(lines)).toBe('idle');
  });
});

describe('needsTerminal idle precedence', () => {
  it('an idle screen whose reply quotes a prompt phrase does not need the terminal', () => {
    const idle = screen([
      '● The installer asks "Do you want to proceed?" and then (y/n); answer y.',
      '',
      '✻ Worked for 12s',
      '',
      '─'.repeat(40),
      '❯ ',
      '─'.repeat(40),
      '  ? for shortcuts',
    ], 20);
    const lines = readBufferTail(term(idle), 15);
    expect(needsTerminal(lines, false)).toBe(false);
  });

  it('a prompt phrase quoted far above the bottom block does not need the terminal', () => {
    const lines = ['Reply: "Do you want to proceed?"', ...Array.from({ length: 10 }, (_, i) => `line ${i}`)];
    expect(needsTerminal(lines, false)).toBe(false);
  });
});

describe('questionOnScreen', () => {
  it('uses the whole screen, not only the bottom rows', () => {
    const rows = ['Which database should we use?', ...Array.from({ length: ROWS - 1 }, (_, i) => `option detail ${i}`)];
    useTerminalStore.setState({ terminals: new Map([['t1', { xterm: term(rows) } as never]]) });
    const q = { question: 'Which database should we use?', header: '', multiSelect: false, options: [] };
    expect(questionOnScreen('t1', q)).toBe(true);
    expect(questionOnScreen('t1', { ...q, question: 'Something else entirely' })).toBe(false);
  });
});
