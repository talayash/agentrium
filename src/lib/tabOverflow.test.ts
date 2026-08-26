import { describe, expect, it } from 'vitest';
import { computeTabOverflow, estimateTabWidth } from './tabOverflow';

describe('estimateTabWidth', () => {
  it('returns a value within the [80, 200] clamp for a normal label', () => {
    const w = estimateTabWidth('abc');
    expect(w).toBeGreaterThanOrEqual(80);
    expect(w).toBeLessThanOrEqual(200);
  });

  it('clamps empty label to the minimum 80px', () => {
    expect(estimateTabWidth('', {})).toBe(80);
  });

  it('clamps very long labels to the maximum 200px', () => {
    expect(estimateTabWidth('a'.repeat(50))).toBe(200);
  });

  it('adds width when the tab is pinned', () => {
    // Use a label long enough to be above the 80px floor so the pin actually
    // moves the estimate - otherwise both are clamped to 80.
    const long = 'x'.repeat(10);
    expect(estimateTabWidth(long, { isPinned: true })).toBeGreaterThan(
      estimateTabWidth(long),
    );
  });

  it('adds width when the status dot is shown', () => {
    const long = 'x'.repeat(10);
    expect(estimateTabWidth(long, { hasStatusDot: true })).toBeGreaterThan(
      estimateTabWidth(long),
    );
  });

  it('handles non-finite / weird inputs defensively (returns clamped minimum)', () => {
    // Cast to any so we can pass hostile inputs without TS complaining.
    // The function should silently floor them to 0, not return NaN.
    expect(estimateTabWidth(null as unknown as string)).toBe(80);
    expect(estimateTabWidth(undefined as unknown as string)).toBe(80);
  });
});

describe('computeTabOverflow', () => {
  it('returns empty arrays for empty tabIds', () => {
    expect(
      computeTabOverflow({
        tabIds: [],
        activeId: null,
        tabWidths: [],
        containerWidth: 500,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: [], hidden: [] });
  });

  it('marks everything visible when all tabs fit in the container', () => {
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: 'a',
        tabWidths: [100, 100, 100],
        containerWidth: 500,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['a', 'b', 'c'], hidden: [] });
  });

  it('treats exact-fit as fully visible (no chevron)', () => {
    // 3 tabs at 100 = 300px, container is exactly 300px - everything fits.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: 'a',
        tabWidths: [100, 100, 100],
        containerWidth: 300,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['a', 'b', 'c'], hidden: [] });
  });

  it('splits into visible prefix + hidden tail when active is already in the prefix', () => {
    // 5 tabs at 100 = 500; container 300, reserve chevron 32 → budget 268 → 2 fit.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c', 'd', 'e'],
        activeId: 'a',
        tabWidths: [100, 100, 100, 100, 100],
        containerWidth: 300,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['a', 'b'], hidden: ['c', 'd', 'e'] });
  });

  it('swaps the last visible slot for the active tab when it would otherwise hide', () => {
    // 2 fit in the budget; active='d' is in the hidden set → swap into slot 2.
    // Hidden reconstructs from original tabIds order minus the visible set.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c', 'd', 'e'],
        activeId: 'd',
        tabWidths: [100, 100, 100, 100, 100],
        containerWidth: 300,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['a', 'd'], hidden: ['b', 'c', 'e'] });
  });

  it('shows just the active tab when budget is too small for even one tab', () => {
    // containerWidth 20 < chevronWidth 32 → budget is negative → nothing fits,
    // but active is preserved so the user can still see where they are.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: 'b',
        tabWidths: [100, 100, 100],
        containerWidth: 20,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['b'], hidden: ['a', 'c'] });
  });

  it('keeps the single active tab visible when it is wider than the budget', () => {
    // Regression: with only one tab open in a narrow strip, the tab was
    // wider than the budget so nothing fit, and the pre-fix active-swap
    // required visible.length > 0 - so it never fired, leaving `visible`
    // empty. The strip then rendered just the "1 hidden" chevron badge
    // with no actual tab. The invariant is: if there is an activeId, at
    // least the active tab must render.
    expect(
      computeTabOverflow({
        tabIds: ['a'],
        activeId: 'a',
        tabWidths: [160],
        containerWidth: 200,
        chevronWidth: 50,
        reservedRight: 96,
      }),
    ).toEqual({ visible: ['a'], hidden: [] });
  });

  it('keeps the active tab visible when no tab fits (multi-tab, wide labels)', () => {
    // Same shape as the single-tab regression, but with siblings: every
    // tab is wider than the budget so the prefix-fit loop finds nothing.
    // Only the active tab is forced visible; the rest stay in `hidden`.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: 'b',
        tabWidths: [160, 160, 160],
        containerWidth: 200,
        chevronWidth: 50,
        reservedRight: 96,
      }),
    ).toEqual({ visible: ['b'], hidden: ['a', 'c'] });
  });

  it('hides everything when budget is non-positive and no activeId is set', () => {
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: null,
        tabWidths: [100, 100, 100],
        containerWidth: 20,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: [], hidden: ['a', 'b', 'c'] });
  });

  it('treats missing widths as the 200px conservative fallback', () => {
    // Only 1 width provided for 3 tabs → indices 1,2 default to 200.
    // Total = 100 + 200 + 200 = 500. Container 300, chevron 32 → budget 268.
    // Only 'a' (100) fits (adding 200 would exceed 268).
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c'],
        activeId: 'a',
        tabWidths: [100],
        containerWidth: 300,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['a'], hidden: ['b', 'c'] });
  });

  it('subtracts reservedRight from the available budget', () => {
    // Container 400, reservedRight 100 → 300 available. Chevron 32 → 268 budget.
    // Same result as the container-300 case above: 2 tabs at 100 each fit.
    expect(
      computeTabOverflow({
        tabIds: ['a', 'b', 'c', 'd'],
        activeId: 'a',
        tabWidths: [100, 100, 100, 100],
        containerWidth: 400,
        chevronWidth: 32,
        reservedRight: 100,
      }),
    ).toEqual({ visible: ['a', 'b'], hidden: ['c', 'd'] });
  });

  it('preserves the pinned-first ordering the caller provides (active swap included)', () => {
    // tabIds already ordered pinned-first (['pin1', 'pin2', ...]). Active is 'b',
    // which lives in the unpinned tail - verify the swap picks it up while
    // pins stay in front.
    // Widths: 5 * 100 = 500. Container 300, chevron 32 → budget 268 → 2 fit.
    // Prefix ['pin1', 'pin2'] fits; active 'b' is hidden → swap into slot 2.
    expect(
      computeTabOverflow({
        tabIds: ['pin1', 'pin2', 'a', 'b', 'c'],
        activeId: 'b',
        tabWidths: [100, 100, 100, 100, 100],
        containerWidth: 300,
        chevronWidth: 32,
      }),
    ).toEqual({ visible: ['pin1', 'b'], hidden: ['pin2', 'a', 'c'] });
  });
});
