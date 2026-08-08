import { describe, expect, it } from 'vitest';
import { addPin, removePin, togglePin } from './pinnedTabs';

describe('pinnedTabs helpers', () => {
  it('addPin adds id if not present, no-op if already pinned', () => {
    // Adds when absent.
    expect(addPin([], 'a')).toEqual(['a']);
    expect(addPin(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);

    // No-op when already pinned — same array reference so shallow-equal
    // selectors can short-circuit.
    const pinned = ['a', 'b'];
    expect(addPin(pinned, 'a')).toBe(pinned);
  });

  it('unpinTab (removePin) removes id if present, no-op if absent', () => {
    // Removes when present.
    expect(removePin(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removePin(['a'], 'a')).toEqual([]);

    // No-op when absent — content unchanged (filter still returns a fresh
    // array, but callers compare by value here).
    expect(removePin(['a', 'b'], 'missing')).toEqual(['a', 'b']);
    expect(removePin([], 'anything')).toEqual([]);
  });

  it('togglePin flips: unpinned → pinned, pinned → unpinned', () => {
    // Unpinned → pinned.
    expect(togglePin([], 'a')).toEqual(['a']);
    expect(togglePin(['a'], 'b')).toEqual(['a', 'b']);

    // Pinned → unpinned.
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
    expect(togglePin(['a'], 'a')).toEqual([]);
  });
});
