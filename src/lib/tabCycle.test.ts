import { describe, expect, it } from 'vitest';
import { cyclableTabIds, nextTabId, type CyclableTab } from './tabCycle';

/** Terse tab factory - only the three fields that drive cycling matter here. */
const tab = (id: string, extra: Partial<CyclableTab> = {}): CyclableTab => ({ id, ...extra });

describe('cyclableTabIds', () => {
  it('returns insertion order when nothing is pinned or hidden', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(cyclableTabIds(tabs, [])).toEqual(['a', 'b', 'c']);
  });

  it('excludes script-child terminals (they render under their parent, not in the strip)', () => {
    const tabs = [tab('a'), tab('a-script', { scriptParentId: 'a' }), tab('b')];
    expect(cyclableTabIds(tabs, [])).toEqual(['a', 'b']);
  });

  it('excludes bottom-pane shell terminals', () => {
    const tabs = [tab('a'), tab('shell', { isShellTerminal: true }), tab('b')];
    expect(cyclableTabIds(tabs, [])).toEqual(['a', 'b']);
  });

  it('matches the tab strip: pinned first, insertion order preserved within each group', () => {
    const tabs = [tab('a'), tab('b'), tab('c'), tab('d')];
    expect(cyclableTabIds(tabs, ['c', 'a'])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('applies the hidden-terminal filter before the pinned partition', () => {
    const tabs = [
      tab('a'),
      tab('a-script', { scriptParentId: 'a' }),
      tab('b'),
      tab('shell', { isShellTerminal: true }),
      tab('c'),
    ];
    // 'a-script' is pinned but hidden - it must not reappear in the pinned block.
    expect(cyclableTabIds(tabs, ['a-script', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('returns an empty list when there are no terminals', () => {
    expect(cyclableTabIds([], [])).toEqual([]);
  });

  it('returns an empty list when every terminal is hidden', () => {
    const tabs = [tab('s1', { scriptParentId: 'a' }), tab('s2', { isShellTerminal: true })];
    expect(cyclableTabIds(tabs, [])).toEqual([]);
  });
});

describe('nextTabId', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('steps forward one tab', () => {
    expect(nextTabId(ids, 'b', 1)).toBe('c');
  });

  it('wraps forward from the last tab to the first', () => {
    expect(nextTabId(ids, 'd', 1)).toBe('a');
  });

  it('steps backward one tab', () => {
    expect(nextTabId(ids, 'b', -1)).toBe('a');
  });

  it('wraps backward from the first tab to the last', () => {
    expect(nextTabId(ids, 'a', -1)).toBe('d');
  });

  it('returns the only tab when there is just one', () => {
    expect(nextTabId(['a'], 'a', 1)).toBe('a');
    expect(nextTabId(['a'], 'a', -1)).toBe('a');
  });

  it('returns null when there are no cyclable tabs', () => {
    expect(nextTabId([], 'a', 1)).toBeNull();
    expect(nextTabId([], null, -1)).toBeNull();
  });

  it('falls back to the first tab going forward when nothing is active', () => {
    expect(nextTabId(ids, null, 1)).toBe('a');
  });

  it('falls back to the last tab going backward when nothing is active', () => {
    expect(nextTabId(ids, null, -1)).toBe('d');
  });

  it('falls back to an end tab when the active terminal is not a visible tab', () => {
    // Focus can sit on a script child or bottom-pane shell, which cyclableTabIds
    // filtered out - cycling should still land on a real tab rather than no-op.
    expect(nextTabId(ids, 'a-script', 1)).toBe('a');
    expect(nextTabId(ids, 'a-script', -1)).toBe('d');
  });
});
