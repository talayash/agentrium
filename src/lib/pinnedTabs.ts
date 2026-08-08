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

/**
 * Drop any pinned ids that don't map to a currently-live terminal. Used by
 * the startup GC in App.tsx after session restore, since restored terminals
 * get fresh UUIDs (`Uuid::new_v4()` in Rust) and 100% of persisted pinned
 * ids are ghosts after app restart. Order is preserved so the surviving
 * pins keep their relative positions.
 */
export function filterLivePins(pinnedIds: string[], liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds);
  return pinnedIds.filter((id) => live.has(id));
}
