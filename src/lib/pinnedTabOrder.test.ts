import { describe, expect, it } from 'vitest';
import { orderTabsPinnedFirst } from './pinnedTabOrder';

describe('orderTabsPinnedFirst', () => {
  it('returns tabIds unchanged when no tabs are pinned', () => {
    expect(orderTabsPinnedFirst(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('returns tabIds unchanged when all tabs are pinned (all in pinned block, same order)', () => {
    expect(orderTabsPinnedFirst(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('partitions mixed pinned + unpinned, preserving intra-group insertion order', () => {
    // Pinned: a, c, e. Unpinned: b, d. Insertion order preserved within each group.
    expect(orderTabsPinnedFirst(['a', 'b', 'c', 'd', 'e'], ['a', 'c', 'e'])).toEqual([
      'a',
      'c',
      'e',
      'b',
      'd',
    ]);
  });

  it('ignores pinnedIds order — final order follows tabIds insertion order', () => {
    // pinnedIds says c-then-a, but result is a-then-c because 'a' comes first in tabIds.
    expect(orderTabsPinnedFirst(['a', 'b', 'c', 'd', 'e'], ['c', 'a'])).toEqual([
      'a',
      'c',
      'b',
      'd',
      'e',
    ]);
  });

  it('silently ignores pinned ids that are not in tabIds (no error, no ghost entry)', () => {
    expect(orderTabsPinnedFirst(['a', 'b'], ['a', 'ghost', 'zzz'])).toEqual(['a', 'b']);
  });

  it('returns empty array for empty tabIds', () => {
    expect(orderTabsPinnedFirst([], ['a', 'b'])).toEqual([]);
    expect(orderTabsPinnedFirst([], [])).toEqual([]);
  });

  it('returns tabIds unchanged when pinnedIds is empty', () => {
    expect(orderTabsPinnedFirst(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('is defensive against duplicate pin ids — treats [a, a] the same as [a]', () => {
    // Even if pinnedIds contains duplicates, each tab id only appears once
    // in the result (based on its single occurrence in tabIds).
    expect(orderTabsPinnedFirst(['a', 'b', 'c'], ['a', 'a'])).toEqual(['a', 'b', 'c']);
    expect(orderTabsPinnedFirst(['a', 'b', 'c'], ['b', 'b'])).toEqual(['b', 'a', 'c']);
  });
});
