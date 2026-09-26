import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

describe('formatRelativeTime', () => {
  it('reads "now" for anything under 45 seconds old', () => {
    expect(formatRelativeTime(0)).toBe('now');
    expect(formatRelativeTime(44_000)).toBe('now');
  });

  it('switches to whole minutes from 45 seconds', () => {
    expect(formatRelativeTime(45_000)).toBe('1m');
    expect(formatRelativeTime(2 * 60_000)).toBe('2m');
    expect(formatRelativeTime(59 * 60_000)).toBe('59m');
  });

  it('switches to whole hours at an hour', () => {
    expect(formatRelativeTime(60 * 60_000)).toBe('1h');
    expect(formatRelativeTime(23 * 60 * 60_000)).toBe('23h');
  });

  it('switches to whole days at a day', () => {
    expect(formatRelativeTime(24 * 60 * 60_000)).toBe('1d');
    expect(formatRelativeTime(9 * 24 * 60 * 60_000)).toBe('9d');
  });

  it('never renders a negative age from a clock that jumped backwards', () => {
    expect(formatRelativeTime(-5_000)).toBe('now');
  });
});
