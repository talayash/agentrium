/**
 * Pure helpers for managing the pinned-tabs id list.
 *
 * Kept out of the store so the toggling logic is trivially unit-testable
 * without hydrating Zustand. Callers (see `appStore.ts`) feed the current
 * `pinnedTabIds` array in and set the result back — no in-place mutation,
 * so React/Zustand change detection is preserved.
 */

/** Add `id` to the list if not already present. Returns the same array
 *  reference on no-op so shallow equality checks in selectors can short-circuit. */
export function addPin(pinnedIds: string[], id: string): string[] {
  return pinnedIds.includes(id) ? pinnedIds : [...pinnedIds, id];
}

/** Remove `id` from the list. Filter always returns a new array, but callers
 *  should treat a no-op remove (id absent) as harmless. */
export function removePin(pinnedIds: string[], id: string): string[] {
  return pinnedIds.filter((x) => x !== id);
}

/** Flip pinned state: pinned → unpinned, unpinned → pinned. */
export function togglePin(pinnedIds: string[], id: string): string[] {
  return pinnedIds.includes(id) ? removePin(pinnedIds, id) : addPin(pinnedIds, id);
}
