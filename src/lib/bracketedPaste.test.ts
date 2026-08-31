import { describe, expect, it } from 'vitest';
import { toBracketedPaste } from './bracketedPaste';

const START = '\x1b[200~';
const END = '\x1b[201~';

describe('toBracketedPaste', () => {
  it('wraps the text in bracketed-paste markers', () => {
    expect(toBracketedPaste('hello')).toBe(`${START}hello${END}`);
  });

  it('keeps embedded newlines literal instead of letting them submit', () => {
    const out = toBracketedPaste('line one\nline two');
    // The newline must survive *inside* the markers - that is what tells the
    // agent "this is one paste", rather than two Enter presses.
    expect(out).toBe(`${START}line one\nline two${END}`);
  });

  it('normalizes Windows CRLF to a single LF', () => {
    // The Windows clipboard hands back \r\n. xterm's native paste path
    // normalizes this; the raw writeToTerminal path did not, so every pasted
    // line arrived with a stray extra line feed.
    expect(toBracketedPaste('a\r\nb\r\nc')).toBe(`${START}a\nb\nc${END}`);
  });

  it('normalizes a lone CR to LF', () => {
    expect(toBracketedPaste('a\rb')).toBe(`${START}a\nb${END}`);
  });

  it('returns an empty string for empty input so nothing is sent', () => {
    // Writing bare markers with no payload would still nudge the agent's
    // input handling for no reason.
    expect(toBracketedPaste('')).toBe('');
  });

  it('does not double-wrap text that is already bracketed', () => {
    const already = `${START}payload${END}`;
    expect(toBracketedPaste(already)).toBe(already);
  });

  it('strips any interior end-marker so pasted content cannot break out', () => {
    // A clipboard payload containing ESC[201~ would otherwise terminate the
    // paste early and let the remainder execute as typed input.
    const out = toBracketedPaste(`safe${END}injected`);
    expect(out).toBe(`${START}safeinjected${END}`);
  });

  it('strips an interior start-marker too', () => {
    const out = toBracketedPaste(`safe${START}more`);
    expect(out).toBe(`${START}safemore${END}`);
  });
});
