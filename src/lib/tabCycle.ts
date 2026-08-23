/**
 * Pure helpers for Ctrl+Tab / Ctrl+Shift+Tab tab cycling.
 *
 * The point of this module is that the keyboard shortcut and the rendered tab
 * strip agree on one order. `TerminalTabs` hides script-child and bottom-pane
 * shell terminals and partitions pinned tabs to the front; a shortcut that
 * walked the terminal store's raw insertion order instead would step onto
 * terminals that have no tab in the strip and ignore pinning, which reads as
 * "Ctrl+Tab jumps around" rather than "next tab".
 *
 * See `pinnedTabOrder.ts` for the pinned-first partition itself.
 */

import { orderTabsPinnedFirst } from './pinnedTabOrder';

/**
 * The slice of `TerminalInstance` that decides whether a terminal is a
 * cyclable tab. Structural on purpose - keeps this module independent of the
 * terminal store. `id` is the instance's `config.id`.
 */
export interface CyclableTab {
  id: string;
  /** Set on npm-script runners, which render below their parent terminal. */
  scriptParentId?: string;
  /** Set on plain shells, which render in the bottom pane. */
  isShellTerminal?: boolean;
}

/** Direction of travel: forward (Ctrl+Tab) or backward (Ctrl+Shift+Tab). */
export type CycleDirection = 1 | -1;

/**
 * Ids of the terminals that appear in the main tab strip, in the order they
 * are drawn there: hidden terminals dropped, then pinned tabs first.
 *
 * Filtering runs before the partition so a stale pin on a hidden terminal
 * can't pull it back into the pinned block.
 */
export function cyclableTabIds(
  tabs: readonly CyclableTab[],
  pinnedIds: readonly string[],
): string[] {
  const visible = tabs
    .filter((t) => !t.scriptParentId && !t.isShellTerminal)
    .map((t) => t.id);
  return orderTabsPinnedFirst(visible, pinnedIds);
}

/**
 * The id one step from `activeId` in `orderedIds`, wrapping at both ends.
 *
 * Returns `null` when there is nothing to cycle. When `activeId` isn't in the
 * list - no active terminal, or focus sits on a script child or bottom-pane
 * shell that `cyclableTabIds` filtered out - falls back to the near end for
 * that direction (first going forward, last going backward) so the keypress
 * still lands on a real tab instead of doing nothing.
 */
export function nextTabId(
  orderedIds: readonly string[],
  activeId: string | null,
  direction: CycleDirection,
): string | null {
  if (orderedIds.length === 0) return null;

  const currentIndex = activeId != null ? orderedIds.indexOf(activeId) : -1;
  if (currentIndex === -1) {
    return direction === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1];
  }

  const nextIndex = (currentIndex + direction + orderedIds.length) % orderedIds.length;
  return orderedIds[nextIndex];
}
