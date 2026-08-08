/**
 * Pure helpers for the tab-strip "Show Hidden Tabs" overflow chevron.
 *
 * The tab strip has a bounded width; when many tabs are open they overflow
 * off-screen. This module computes — without any DOM measurement — which
 * tabs fit and which need to move into a chevron dropdown, keeping the
 * active tab visible when possible.
 *
 * Kept pure (no React, no DOM refs) so it can be unit-tested and reasoned
 * about independently. `TerminalTabs.tsx` (Phase 4b Task B) wires this to a
 * ResizeObserver that tracks the real container width.
 */

export interface TabWidthHints {
  isPinned?: boolean;
  hasStatusDot?: boolean;
}

/**
 * Estimate a tab's rendered width in px from its label + adornments.
 *
 * Deterministic (no DOM measurement) so overflow computation stays pure.
 * Approximates the actual layout in `TerminalTabs.tsx`:
 *   px-3 padding (12+12=24) + optional pin (10+8) + optional status dot
 *   (6+8) + label glyph width (~7px per char, monospace-ish) + close
 *   button (16). Clamped to [80, 200] to match the browser's flex-shrink
 *   behavior on real tabs — a lone glyph never renders narrower than 80px
 *   and a long label collapses to 200px before ellipsis.
 *
 * Defensive: non-finite / negative label lengths are floored to 0, so a
 * malformed input still returns the clamped minimum instead of NaN.
 */
export function estimateTabWidth(label: string, opts: TabWidthHints = {}): number {
  const base = 24 /* padding */ + 16 /* close button */;
  const pin = opts.isPinned ? 18 : 0;
  const dot = opts.hasStatusDot ? 14 : 0;
  const rawLen = typeof label === 'string' ? label.length : 0;
  const safeLen = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : 0;
  const glyphs = safeLen * 7;
  return Math.max(80, Math.min(200, base + pin + dot + glyphs));
}

export interface OverflowParams {
  tabIds: readonly string[];
  activeId: string | null;
  /** Parallel to tabIds — width of each tab in px. Length should match tabIds. */
  tabWidths: readonly number[];
  containerWidth: number;
  chevronWidth: number;
  /** Extra reserved space at the right (for `+` button, grid toggle, etc). */
  reservedRight?: number;
}

export interface OverflowResult {
  visible: string[];
  hidden: string[];
}

/**
 * Decide which tabs fit in the strip and which move into the "Show Hidden
 * Tabs" dropdown, keeping the active tab visible when possible.
 *
 * Algorithm:
 *   1. If all tabs fit in `(containerWidth - reservedRight)`, everything is
 *      visible; no chevron needed.
 *   2. Otherwise reserve `chevronWidth`. Take the longest prefix of `tabIds`
 *      whose cumulative width fits in the available space.
 *   3. If `activeId` is in the hidden set, swap it into the last visible
 *      slot so the active tab always renders.
 *
 * Edge cases:
 *   - Empty `tabIds` → both arrays empty.
 *   - `containerWidth` too small for even one tab (budget ≤ 0) → active tab
 *     shown alone if present, otherwise everything hidden.
 *   - `tabWidths` shorter than `tabIds` → missing entries treated as the
 *     max clamp (200) so the tab is conservatively counted. Silent — the
 *     helper stays pure and side-effect-free.
 */
export function computeTabOverflow(params: OverflowParams): OverflowResult {
  const { tabIds, activeId, tabWidths, containerWidth, chevronWidth } = params;
  const reservedRight = params.reservedRight ?? 0;

  if (tabIds.length === 0) return { visible: [], hidden: [] };

  const widthAt = (i: number): number => tabWidths[i] ?? 200;
  const totalWidth = tabIds.reduce((sum, _id, i) => sum + widthAt(i), 0);
  const availableForTabs = containerWidth - reservedRight;

  // Everything fits — no chevron needed.
  if (totalWidth <= availableForTabs) {
    return { visible: [...tabIds], hidden: [] };
  }

  // Overflow: reserve chevron width.
  const budget = availableForTabs - chevronWidth;

  // Budget too small for anything — show active if present, else hide all.
  if (budget <= 0) {
    if (activeId && tabIds.includes(activeId)) {
      return {
        visible: [activeId],
        hidden: tabIds.filter((id) => id !== activeId),
      };
    }
    return { visible: [], hidden: [...tabIds] };
  }

  // Find longest prefix whose cumulative width fits in the budget.
  let acc = 0;
  let fitCount = 0;
  for (let i = 0; i < tabIds.length; i++) {
    const next = acc + widthAt(i);
    if (next > budget) break;
    acc = next;
    fitCount++;
  }

  const visible = tabIds.slice(0, fitCount);
  const hidden = tabIds.slice(fitCount);

  // Keep active tab visible: swap it into the last visible slot.
  if (activeId && hidden.includes(activeId) && visible.length > 0) {
    const newVisible = [...visible.slice(0, -1), activeId];
    const visibleSet = new Set(newVisible);
    return {
      visible: newVisible,
      hidden: tabIds.filter((id) => !visibleSet.has(id)),
    };
  }

  return { visible, hidden };
}
