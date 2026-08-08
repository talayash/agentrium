/**
 * Pure helper for rendering a tab strip with pinned tabs first.
 *
 * Kept separate from `pinnedTabs.ts` (which is add/remove/toggle) because
 * ordering is a distinct concern — the tab-strip needs a stable "pinned
 * block, then everything else" view without touching the underlying
 * insertion-order source of truth.
 */

/**
 * Reorder a list of tab ids so pinned tabs come first, preserving each
 * group's original insertion order. Ids not in `pinnedIds` retain their
 * original relative order after the pinned block.
 *
 * The order of `pinnedIds` is intentionally ignored — only `tabIds`
 * insertion order drives the final sequence. This matches how users
 * perceive tab pinning: pinning doesn't rearrange, it just partitions.
 *
 * Silently ignores ids in `pinnedIds` that aren't in `tabIds` (defensive
 * against stale pin state after tab close) and duplicate pin ids.
 *
 * Example:
 *   tabIds     = ['a', 'b', 'c', 'd', 'e']
 *   pinnedIds  = ['c', 'a']  // (pin order doesn't matter — insertion order wins)
 *   result     = ['a', 'c', 'b', 'd', 'e']
 */
export function orderTabsPinnedFirst(
  tabIds: readonly string[],
  pinnedIds: readonly string[],
): string[] {
  const pinSet = new Set(pinnedIds);
  const pinned: string[] = [];
  const unpinned: string[] = [];
  for (const id of tabIds) {
    (pinSet.has(id) ? pinned : unpinned).push(id);
  }
  return [...pinned, ...unpinned];
}
