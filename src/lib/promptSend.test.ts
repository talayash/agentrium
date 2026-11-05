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
});
