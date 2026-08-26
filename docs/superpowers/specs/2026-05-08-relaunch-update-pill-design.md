# Relaunch-Update Pill - Design

**Date:** 2026-05-08
**Status:** Approved (pending user review)

## Problem

Today, ClaudeTerminal only checks for updates 3 seconds after the app launches. Users who never close the app and never open Settings never learn that a new version is available - they sit on stale builds indefinitely. There is also no visible "an update is waiting" affordance once one has been found; the only entry points are the modal banner (which can be dismissed) and the Settings → Updates panel (which the idle user never visits).

## Goal

Match the experience of Claude Desktop's "Relaunch update vX.X.X" pill: discover updates in the background, download them silently, and surface a single always-visible button in the title bar that the user can click whenever they're ready to restart.

## Non-goals

- Adding automated test infrastructure for the updater store. Manual smoke testing only for this change.
- Re-downloading a newer release if one ships while an older download is already staged. The user receives the next release on their next launch.
- Showing download progress inside the title bar pill. Silent means silent.
- A badge or indicator on the Settings icon. The pill is the only top-level affordance.

## User-visible behavior

1. App is open. A new release ships.
2. Within ~4 hours (or immediately when the user next focuses the window after a stale period), the app silently checks GitHub, finds the update, and downloads it in the background.
3. A pill appears in the title bar, to the left of the File Changes button: `↻ Relaunch · v1.21.0`. It pulses subtly once on entry, then sits quietly.
4. The user clicks the pill whenever convenient. The app saves session state, relaunches, and comes back on the new version with terminals restored.

If the download fails, the pill switches to an error variant (`⚠ Update failed`) and clicking it retries the check. The next periodic tick also retries automatically.

## Architecture

### Update lifecycle

```
Trigger (startup / 4h interval / focus regained)
    └─> updaterStore.checkForUpdates()
            └─ status: 'available'
                 └─> updaterStore.downloadAndInstall()  (auto)
                       └─ status: 'ready'
                            └─> <UpdatePill> renders in <TitleBar>
                                  └─ click → restart()
                                        └─ save_session_for_restore + relaunch()
```

### Components

- **`updaterStore`** (existing, extended) - owns the entire update state machine.
  - New field: `lastCheckAt: number | null` - wall-clock timestamp of the most recent `checkForUpdates` call (success or failure).
  - New behavior: when `checkForUpdates` resolves with `status === 'available'`, the store immediately invokes `downloadAndInstall` itself instead of waiting for UI.
  - The existing guard ("don't re-check if status is `downloading` or `ready`") stays. Once an update is staged, polling pauses until the user restarts or an error resets the state.

- **Background scheduler** (new, lives in a top-level component - `AutoUpdater` is the natural home, since it already owns the startup check).
  - **Periodic check:** `setInterval` of 4 hours, started after the initial startup check resolves. On each tick, compares `Date.now() - lastCheckAt` to the interval - only fires if at least 4 hours of wall-clock time have actually elapsed (guards against drift on a sleeping/throttled timer).
  - **Focus re-check:** `getCurrentWindow().onFocusChanged()` listener. Fires `checkForUpdates` only when focus is gained AND `Date.now() - lastCheckAt > 30 * 60 * 1000` (30-minute floor prevents thrash on every alt-tab).
  - All listeners are cleaned up on unmount.

- **`AutoUpdater` banner** (existing, modified) - currently auto-opens on `status === 'available'`. Changed to auto-open only on `status === 'ready'`, since the `available` and `downloading` states are now silent for the auto-flow. An explicit Settings-initiated check still surfaces all states inside the Settings modal itself.

- **`UpdatePill`** (new component) - small pill rendered inside `TitleBar`'s right cluster, positioned **before** the `FileDiff` button. Subscribes to `useUpdaterStore`. Renders nothing unless `status === 'ready'` or `status === 'error'`.

### `UpdatePill` visual states

**Ready (primary case):**

- Content: `↻ Relaunch · v{version}` (icon: `RotateCw` from lucide)
- Style: pill shape, height 24px, `bg-accent-primary/15`, `text-accent-primary`, `ring-1 ring-inset ring-accent-primary/30`
- Tooltip: `Restart to install update v{version} - your terminals will be restored`
- Click handler: `useUpdaterStore.getState().restart()`
- Animation: subtle one-time entry pulse via Framer Motion (scale 1 → 1.05 → 1, 600ms) so a user already looking at the title bar notices it
- Max width: 180px with truncation on the version string for safety on narrow windows

**Error:**

- Content: `⚠ Update failed`
- Style: `bg-error/15`, `text-error`
- Tooltip: shows the error message from `updaterStore.error`
- Click handler: `checkForUpdates()` (manual retry)

**Hidden:** any other status (`idle`, `checking`, `available`, `downloading`, `up-to-date`).

### Title bar layout

The right action cluster changes:

Before: `[FileDiff] [Users] [Lightbulb] | [Settings]`
After: `[UpdatePill?] [FileDiff] [Users] [Lightbulb] | [Settings]`

The pill is conditionally rendered, so it does not reserve space when absent.

## Files touched

- `src/store/updaterStore.ts` - add `lastCheckAt` field; chain `downloadAndInstall` automatically after `available`; preserve existing error/guard behavior. Note: the existing `downloadAndInstall` re-runs `check()` internally - for the auto-chained call we should pass the already-fetched `Update` handle through (or refactor `downloadAndInstall` to accept one) to avoid a redundant network round-trip. The Settings-initiated path can keep the re-check.
- `src/components/AutoUpdater.tsx` - change auto-show condition from `available` to `ready`; add periodic interval and focus listener that drive `checkForUpdates`.
- `src/components/UpdatePill.tsx` - **new** component, ~80 lines.
- `src/components/TitleBar.tsx` - render `<UpdatePill />` as the first child of the right action cluster.

## Edge cases

1. **User triggers a Settings check while the pill is already in the `ready` state.** The existing store guard returns `{ available: status === 'ready' }` without re-checking. The Settings modal shows the appropriate state, and the pill stays. No change needed.
2. **User dismisses the post-download banner and then ignores the pill for hours.** The `dismissed` flag only affects the banner; the pill persists across dismissal. This is the intended "remember me" surface.
3. **A newer release ships while v1.21.0 is already staged.** Polling is paused once `status === 'ready'`. The user restarts to v1.21.0, and v1.21.1 is picked up on the next launch's startup check. Re-downloading mid-session would be worse UX than missing one revision.
4. **Restart fails.** Existing `restart()` already sets the `error` field; the pill flips to its error variant.
5. **Window minimized for days, then restored.** `onFocusChanged(true)` fires; the 30-minute floor passes; `checkForUpdates` runs; an update is found; silent download proceeds; pill appears. **This is the headline user case.**
6. **Tauri updater returns an update with the same version we are running.** The plugin's `check()` already filters this - no extra guard needed.
7. **Download fails on a transient network error.** Status becomes `error`; the pill shows the error variant. The next 4-hour periodic tick will retry automatically. We deliberately do not retry immediately to avoid hammering the endpoint on persistent failures.

## Testing

- **Manual smoke test of the ready-state pill:** temporarily seed the store with `status: 'ready'` and a fake `updateInfo`, verify the pill renders, the tooltip is correct, and clicking it calls `restart()` (which saves the session before relaunching).
- **Periodic check:** in dev, reduce the interval to 30 seconds, watch `lastCheckAt` advance, and confirm a network request fires for the latest.json endpoint.
- **Focus re-check:** with a stale `lastCheckAt`, blur and re-focus the window; confirm `checkForUpdates` runs.
- **Failure path:** force `downloadAndInstall` to throw; confirm the pill shows the error variant and a manual click triggers a retry.

No automated tests are added in this change. Adding test infrastructure for the updater store is a separate effort.

## Risk notes

- **Silent background download uses bandwidth without an explicit per-update consent step.** This is an intentional trade-off - it matches Claude Desktop's behavior and ClaudeTerminal release artifacts are small (~10MB NSIS / ~6MB MSI). Users who object can still ignore the pill; nothing is installed without a click.
- **The 4-hour interval and 30-minute focus floor are picked, not measured.** If telemetry later shows users restarting much more often than expected, the cadence can be tuned without redesign.
