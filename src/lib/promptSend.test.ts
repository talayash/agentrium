import { describe, expect, it, vi } from 'vitest';
import { PASTE_END, PASTE_START, buildPromptKeys, sendPrompt } from './promptSend';
import { useTerminalStore } from '../store/terminalStore';

describe('buildPromptKeys', () => {
  it('single line is text then Enter', () => {
    expect(buildPromptKeys('hello')).toEqual(['hello', '\r']);
  });
  it('multiline prompt is one bracketed paste then Enter', () => {
    expect(buildPromptKeys('a\nb')).toEqual([`${PASTE_START}a\nb${PASTE_END}`, '\r']);
  });
  it('trailing whitespace trimmed', () => {
    expect(buildPromptKeys('hello \n\n  ')).toEqual(['hello', '\r']);
  });
  it('empty sends nothing', () => {
    expect(buildPromptKeys('  \n ')).toEqual([]);
  });
  it('slash command sent as is', () => {
    expect(buildPromptKeys('/compact')).toEqual(['/compact', '\r']);
  });
  it('embedded paste end marker cannot escape the paste', () => {
    const [first] = buildPromptKeys('a\n\x1b[201~rm -rf\nb');
    expect(first!.indexOf(PASTE_START)).toBe(0);
    expect(first!.split(PASTE_START)).toHaveLength(2);
    expect(first!.split(PASTE_END)).toHaveLength(2);
    expect(first!.endsWith(PASTE_END)).toBe(true);
  });
  it('lone CR is treated as a newline', () => {
    expect(buildPromptKeys('a\rb')).toEqual([`${PASTE_START}a\nb${PASTE_END}`, '\r']);
    expect(buildPromptKeys('a\r\nb')).toEqual([`${PASTE_START}a\nb${PASTE_END}`, '\r']);
  });
  it('single line strips escape sequences', () => {
    const [first] = buildPromptKeys('hi\x1b[Bthere');
    expect(first).not.toContain('\x1b');
    expect(first).toBe('hi[Bthere');
  });
});

describe('sendPrompt', () => {
  it('clears the agent input line before typing the prompt', async () => {
    const sendKeySequence = vi.fn().mockResolvedValue(undefined);
    useTerminalStore.setState({ terminals: new Map([['t1', { xterm: null } as never]]), sendKeySequence });
    await sendPrompt('t1', 'hello');
    expect(sendKeySequence).toHaveBeenCalledWith('t1', ['\x15'.repeat(4), 'hello', '\r']);
  });

  it('sends nothing for an empty prompt', async () => {
    const sendKeySequence = vi.fn().mockResolvedValue(undefined);
    useTerminalStore.setState({ sendKeySequence });
    await sendPrompt('t1', '  ');
    expect(sendKeySequence).not.toHaveBeenCalled();
  });
});
