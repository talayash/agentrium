/**
 * Pure selectors for the "Close Others" / "Close All But Pinned" bulk-close
 * context menu actions on the terminal tab strip.
 *
 * Kept out of the component so the filtering logic is trivially
 * unit-testable - the component just maps the result through the store's
 * existing `closeTerminal(id)` mechanism.
 *
 * Neither helper closes anything itself; they return the id list the caller
 * should iterate and pass to `closeTerminal`. This keeps them free of any
 * Zustand / IPC coupling.
 */

/**
 * Ids to close when the user picks "Close Others" on the tab whose id is
 * `keepId`. Returns every id in `tabIds` except `keepId`, preserving the
 * caller's order. If `keepId` isn't in `tabIds` (stale menu, defensive),
 * every id is returned - mirrors the user's intent ("close all except this
 * one") since the "this one" is already gone.
 */
export function idsToCloseForOthers(
  tabIds: readonly string[],
  keepId: string,
): string[] {
  return tabIds.filter((id) => id !== keepId);
}

/**
 * Ids to close when the user picks "Close All But Pinned". Returns every id
 * in `tabIds` that is NOT in `pinnedIds`. Preserves `tabIds` order.
 */
export function idsToCloseForAllButPinned(
  tabIds: readonly string[],
  pinnedIds: readonly string[],
): string[] {
  const pinned = new Set(pinnedIds);
  return tabIds.filter((id) => !pinned.has(id));
}
