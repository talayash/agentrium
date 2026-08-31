import { describe, expect, it } from 'vitest';
import { resolveAppTheme } from './appTheme';

describe('resolveAppTheme', () => {
  it('honours an explicit choice regardless of the OS preference', () => {
    expect(resolveAppTheme('dark', true)).toBe('dark');
    expect(resolveAppTheme('light', false)).toBe('light');
  });

  it('follows the OS preference on auto', () => {
    expect(resolveAppTheme('auto', true)).toBe('light');
    expect(resolveAppTheme('auto', false)).toBe('dark');
  });
});
