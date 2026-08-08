import { describe, expect, it } from 'vitest';
import { idsToCloseForOthers, idsToCloseForAllButPinned } from './closeTabActions';

describe('idsToCloseForOthers', () => {
  it('returns every id except the kept one, preserving order', () => {
    expect(idsToCloseForOthers(['a', 'b', 'c', 'd'], 'b')).toEqual(['a', 'c', 'd']);
  });

  it('returns empty array when the kept id is the only tab', () => {
    expect(idsToCloseForOthers(['only'], 'only')).toEqual([]);
  });

  it('returns empty array for empty tabIds', () => {
    expect(idsToCloseForOthers([], 'anything')).toEqual([]);
  });

  it('returns all ids unchanged when keepId is not in the list (defensive)', () => {
    // If the right-clicked tab has already been closed by the time the user
    // clicks the menu item, "close all except that one" collapses to
    // "close everything left".
    expect(idsToCloseForOthers(['a', 'b', 'c'], 'gone')).toEqual(['a', 'b', 'c']);
  });
});

describe('idsToCloseForAllButPinned', () => {
  it('returns only ids not in pinnedIds, preserving order', () => {
    expect(idsToCloseForAllButPinned(['a', 'b', 'c', 'd'], ['b', 'd'])).toEqual(['a', 'c']);
  });

  it('returns every id when nothing is pinned', () => {
    expect(idsToCloseForAllButPinned(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array when every id is pinned', () => {
    expect(idsToCloseForAllButPinned(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('returns empty array for empty tabIds', () => {
    expect(idsToCloseForAllButPinned([], ['a'])).toEqual([]);
    expect(idsToCloseForAllButPinned([], [])).toEqual([]);
  });

  it('silently ignores pinned ids that are not in tabIds (stale pin state)', () => {
    // A pinned id may reference a terminal that no longer exists — the
    // helper shouldn't crash or produce ghost entries.
    expect(idsToCloseForAllButPinned(['a', 'b'], ['a', 'ghost'])).toEqual(['b']);
  });
});
