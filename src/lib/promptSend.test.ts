import { describe, expect, it } from 'vitest';
import { PASTE_END, PASTE_START, buildPromptKeys } from './promptSend';

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
