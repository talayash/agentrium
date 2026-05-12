# Relaunch-Update Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-Desktop-style "Relaunch update vX.X.X" pill in the title bar so idle users see updates without re-opening Settings, with silent background download every 4 hours and on focus regained.

**Architecture:** Extend `updaterStore` to track `lastCheckAt` and auto-chain `downloadAndInstall` after `available`. Add a periodic timer + focus listener in `AutoUpdater` that drive `checkForUpdates`. The existing banner only auto-opens on `ready`. A new `UpdatePill` component renders in `TitleBar` whenever status is `ready` or `error`.

**Tech Stack:** React 18 + TypeScript + Zustand, Tauri 2.x window/process APIs, Framer Motion, Tailwind, lucide-react.

**Testing note:** This project has no JS test framework configured (no `vitest`/`jest`, no `test` script in `package.json`). Each task uses **manual verification steps** instead of automated tests, exactly as spec'd in the design doc. Be exact about what to click/observe.

**Reference spec:** `docs/superpowers/specs/2026-05-08-relaunch-update-pill-design.md`

---

## File Structure

**Created:**
- `src/components/UpdatePill.tsx` — small pill that subscribes to `useUpdaterStore` and renders nothing unless status is `ready` or `error`. ~80 lines.

**Modified:**
- `src/store/updaterStore.ts` — add `lastCheckAt: number | null`; refactor `downloadAndInstall` to optionally accept a pre-fetched `Update` handle; chain auto-download after `available`.
- `src/components/AutoUpdater.tsx` — banner only auto-opens on `ready`; add 4-hour periodic interval and focus-regained listener that call `checkForUpdates`. Also: wrap one `onClick={downloadAndInstall}` handler in `() => downloadAndInstall()` so React's `MouseEvent` isn't passed as `preFetched` (mechanical consequence of the Task 1 signature change).
- `src/components/SettingsModal.tsx` — wrap one `onClick={appUpdater.downloadAndInstall}` handler in `() => appUpdater.downloadAndInstall()` for the same reason.
- `src/components/TitleBar.tsx` — render `<UpdatePill />` as the first child of the right action cluster, before `<FileDiff />` button.

---

## Task 1: Refactor `downloadAndInstall` to accept a pre-fetched Update

**Why first:** Auto-chaining (Task 3) calls `downloadAndInstall` immediately after a successful `check()`. Without a refactor, the store would call `check()` twice in a row — wasted network round-trip.

**Files:**
- Modify: `src/store/updaterStore.ts`

- [ ] **Step 1: Read the current `downloadAndInstall` implementation**

Open `src/store/updaterStore.ts` and confirm the current shape:
```ts
downloadAndInstall: async () => {
  try {
    set({ status: 'downloading', downloadProgress: 0 });
    const update = await check();
    if (!update) {
      set({ status: 'error', error: 'Update no longer available' });
      return false;
    }
    // ... downloadAndInstall(event => …)
  }
}
```

- [ ] **Step 2: Update the `UpdaterState` interface**

In `src/store/updaterStore.ts`, change the interface signature:

```ts
interface UpdaterState {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number;
  error: string | null;
  lastCheckAt: number | null;

  checkForUpdates: () => Promise<{ available: boolean }>;
  downloadAndInstall: (preFetched?: Update) => Promise<boolean>;
  restart: () => Promise<void>;
}
```

Add the `Update` type import at the top:
```ts
import { check, type Update } from '@tauri-apps/plugin-updater';
```

- [ ] **Step 3: Initialise `lastCheckAt` in the store default state**

```ts
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  downloadProgress: 0,
  error: null,
  lastCheckAt: null,
  // …
}));
```

- [ ] **Step 4: Refactor `downloadAndInstall` to use the pre-fetched handle when provided**

Replace the existing `downloadAndInstall` body:

```ts
downloadAndInstall: async (preFetched?: Update) => {
  try {
    set({ status: 'downloading', downloadProgress: 0 });
    const update = preFetched ?? (await check());
    if (!update) {
      set({ status: 'error', error: 'Update no longer available' });
      return false;
    }

    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength || 0;
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            set({ downloadProgress: Math.round((downloaded / contentLength) * 100) });
          }
          break;
        case 'Finished':
          set({ downloadProgress: 100 });
          break;
      }
    });

    set({ status: 'ready' });
    return true;
  } catch (err) {
    console.error('Update download failed:', err);
    const msg = err instanceof Error ? err.message : String(err);
    set({ status: 'error', error: `Failed to auto-update: ${msg}. Please download manually.` });
    return false;
  }
},
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/updaterStore.ts
git commit -m "refactor(updater): accept pre-fetched Update handle in downloadAndInstall"
```

---

## Task 2: Track `lastCheckAt` in `checkForUpdates`

**Files:**
- Modify: `src/store/updaterStore.ts`

- [ ] **Step 1: Set `lastCheckAt` on every `checkForUpdates` invocation**

Inside `checkForUpdates`, after the early-return guard at the top, set the timestamp **before** the network call so the focus/interval scheduler doesn't re-fire while a check is in flight. After the `try` block opens, the first line should be `set({ status: 'checking', error: null, lastCheckAt: Date.now() });`.

Find this code in `src/store/updaterStore.ts`:
```ts
try {
  set({ status: 'checking', error: null });
```

Change to:
```ts
try {
  set({ status: 'checking', error: null, lastCheckAt: Date.now() });
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Manual verification**

Run: `npm run tauri dev`

Once the app loads:
1. Open the React DevTools console (Tauri dev window has DevTools).
2. In console: `window.__TAURI__ ? 'tauri ready' : 'not ready'` — confirm Tauri is loaded.
3. After ~3 seconds (the startup check runs), inspect Zustand state:
   `useUpdaterStore.getState().lastCheckAt` — should be a millisecond timestamp roughly equal to `Date.now()`.

If you can't access `useUpdaterStore` from the console, add a temporary `(window as any).__updater = useUpdaterStore;` line at module scope in `updaterStore.ts`, verify, then remove it before committing.

Expected: `lastCheckAt` is non-null after the startup check.

- [ ] **Step 4: Commit**

```bash
git add src/store/updaterStore.ts
git commit -m "feat(updater): record lastCheckAt timestamp on every check"
```

---

## Task 3: Auto-chain `downloadAndInstall` after `available`

**Files:**
- Modify: `src/store/updaterStore.ts`

- [ ] **Step 1: Trigger silent download when an update is found**

Inside `checkForUpdates`, find the `if (update)` branch:

```ts
if (update) {
  set({
    updateInfo: {
      version: update.version,
      date: update.date || '',
      body: update.body || '',
    },
    status: 'available',
  });
  return { available: true };
}
```

Change it so the store kicks off the download itself, passing the already-fetched `update`:

```ts
if (update) {
  set({
    updateInfo: {
      version: update.version,
      date: update.date || '',
      body: update.body || '',
    },
    status: 'available',
  });
  // Silently download in the background. Failures land in `error` state;
  // the title bar pill renders an error variant that retries.
  void get().downloadAndInstall(update);
  return { available: true };
}
```

The `void` keyword + `get()` access is required because we don't want to await the download (it can take minutes); we just hand off the work and let the store's state transitions drive the UI.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Manual verification (when no real update is available)**

Without a real new release on GitHub, `check()` will return `null` and you'll see `status: 'up-to-date'`. To verify the auto-chain logic without shipping a release:

1. Open `src/store/updaterStore.ts`.
2. Temporarily add right after the `const update = await check({ headers });` line:
   ```ts
   if (!update && import.meta.env.DEV) {
     // Dev-only force-trigger to verify auto-chain wiring; remove before commit.
     const fakeUpdate = { version: '99.99.99', date: '', body: 'test', downloadAndInstall: async () => {} } as unknown as Update;
     set({ updateInfo: { version: '99.99.99', date: '', body: 'test' }, status: 'available' });
     void get().downloadAndInstall(fakeUpdate);
     return { available: true };
   }
   ```
3. Run `npm run tauri dev`.
4. After the 3-second startup check, observe in DevTools console (with the temporary `__updater` global from Task 2 if needed):
   - `useUpdaterStore.getState().status` transitions: `idle` → `checking` → `available` → `downloading` → `ready`.
5. **Remove the temporary block** and the temporary `__updater` global. Run `npm run tauri dev` again to confirm the app boots cleanly.

Expected: status transitions land at `ready` without manual user action. The banner does NOT pop up during this dev test (Task 4 changes the banner condition; until Task 4 is committed the banner will still appear briefly on `available` — that's fine for this verification).

- [ ] **Step 4: Commit**

```bash
git add src/store/updaterStore.ts
git commit -m "feat(updater): auto-download in background once update is available"
```

---

## Task 4: Banner only auto-opens on `ready`

**Files:**
- Modify: `src/components/AutoUpdater.tsx`

The current banner auto-opens on `available` and walks the user through Download → Install → Restart. With auto-download, that intermediate state is silent. The banner should now only appear when the update is fully downloaded and ready to relaunch.

- [ ] **Step 1: Change the auto-show effect's condition**

In `src/components/AutoUpdater.tsx`, find the startup check effect (around lines 14-31) and the available-watcher effect (around lines 33-38).

Replace the available-watcher with a ready-watcher:

```tsx
// Show banner when update is downloaded and ready to install
useEffect(() => {
  if (status === 'ready' && !dismissed) {
    setShowBanner(true);
  }
}, [status, dismissed]);
```

Also update the startup check effect — it currently sets `setShowBanner(true)` on `result.available`. Since download is now automatic, the banner shouldn't pop up on `available`. Change:

```tsx
useEffect(() => {
  let cancelled = false;
  const timer = setTimeout(async () => {
    try {
      await checkForUpdates();
      // Banner will auto-open via the ready-watcher effect once the
      // background download completes.
    } catch {
      // Silently ignore update check failures on startup
    }
  }, 3000);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}, []);
```

Note: the `cancelled` variable is no longer read inside the timer body, so you can also simplify by removing it. The `clearTimeout` cleanup is sufficient.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes. If you removed the unused `cancelled` flag, also confirm no linting warnings.

- [ ] **Step 3: Manual verification**

1. Run `npm run tauri dev`.
2. Reproduce the dev-only force-trigger from Task 3 (re-add the temporary block, run, remove).
3. With auto-chain firing, observe the banner does NOT appear on `available` or `downloading`. It DOES appear once `status` becomes `ready`.

Expected: banner only shows on `ready`. The "Restart Now" / "Later" buttons inside the banner still work (they're untouched).

- [ ] **Step 4: Commit**

```bash
git add src/components/AutoUpdater.tsx
git commit -m "feat(updater): banner only auto-opens once update is ready to install"
```

---

## Task 5: Periodic 4-hour update check

**Files:**
- Modify: `src/components/AutoUpdater.tsx`

- [ ] **Step 1: Add a periodic interval that re-checks**

In `src/components/AutoUpdater.tsx`, add a new `useEffect` next to the startup check effect:

```tsx
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Periodic background check so users who never relaunch still see updates.
useEffect(() => {
  const id = setInterval(() => {
    const last = useUpdaterStore.getState().lastCheckAt;
    // Guard against drift on a sleeping/throttled timer — only fire if
    // at least 4h of wall-clock time have actually elapsed.
    if (last !== null && Date.now() - last < FOUR_HOURS_MS) return;
    void checkForUpdates();
  }, FOUR_HOURS_MS);
  return () => clearInterval(id);
}, [checkForUpdates]);
```

The `FOUR_HOURS_MS` constant should live at module scope (above the component). The store's existing guard ("don't re-check if `downloading` or `ready`") prevents redundant work, so we don't need to repeat it here.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Manual verification**

1. Open `src/components/AutoUpdater.tsx` and temporarily change `FOUR_HOURS_MS` to `30 * 1000` (30 seconds).
2. Run `npm run tauri dev`.
3. After the startup check, watch `useUpdaterStore.getState().lastCheckAt` in DevTools console.
4. Wait 30s. Confirm `lastCheckAt` advances by ~30s. Repeat once more to confirm interval is recurring.
5. **Restore `FOUR_HOURS_MS` to `4 * 60 * 60 * 1000`** before committing.

Expected: `lastCheckAt` updates on the interval cadence.

- [ ] **Step 4: Commit**

```bash
git add src/components/AutoUpdater.tsx
git commit -m "feat(updater): re-check for updates every 4 hours"
```

---

## Task 6: Focus-regained re-check

**Files:**
- Modify: `src/components/AutoUpdater.tsx`

- [ ] **Step 1: Add focus listener with a 30-minute floor**

At the top of `src/components/AutoUpdater.tsx`, import:

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window';
```

Below the periodic-interval effect, add:

```tsx
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

// Re-check when the window regains focus after a long idle, so a user
// who minimized the app for hours/days sees updates immediately on return.
useEffect(() => {
  let unlisten: (() => void) | undefined;
  const win = getCurrentWindow();

  win.onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    const last = useUpdaterStore.getState().lastCheckAt;
    if (last !== null && Date.now() - last < THIRTY_MINUTES_MS) return;
    void checkForUpdates();
  }).then((un) => { unlisten = un; });

  return () => {
    unlisten?.();
  };
}, [checkForUpdates]);
```

`THIRTY_MINUTES_MS` should live at module scope alongside `FOUR_HOURS_MS`.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Manual verification**

1. Open `src/components/AutoUpdater.tsx` and temporarily change `THIRTY_MINUTES_MS` to `5 * 1000` (5 seconds).
2. Run `npm run tauri dev`.
3. After the 3-second startup check, click another window to blur the Tauri window.
4. Wait 6 seconds, then click the Tauri window to bring it back to focus.
5. In DevTools console, confirm `useUpdaterStore.getState().lastCheckAt` advanced.
6. Click away and back again immediately. Confirm `lastCheckAt` did NOT advance (because <5s have passed since the last check — the floor protected it).
7. **Restore `THIRTY_MINUTES_MS` to `30 * 60 * 1000`** before committing.

Expected: focus re-check fires after the floor passes, doesn't fire if it hasn't.

- [ ] **Step 4: Commit**

```bash
git add src/components/AutoUpdater.tsx
git commit -m "feat(updater): re-check on window focus after 30-minute idle"
```

---

## Task 7: Build the `UpdatePill` component

**Files:**
- Create: `src/components/UpdatePill.tsx`

- [ ] **Step 1: Create the new component file**

Create `src/components/UpdatePill.tsx` with this content:

```tsx
import { motion, AnimatePresence } from 'framer-motion';
import { RotateCw, AlertTriangle } from 'lucide-react';
import { useUpdaterStore } from '../store/updaterStore';

export function UpdatePill() {
  const { status, updateInfo, error, restart, checkForUpdates } = useUpdaterStore();

  if (status !== 'ready' && status !== 'error') {
    return null;
  }

  if (status === 'error') {
    return (
      <button
        onClick={() => void checkForUpdates()}
        title={error || 'Update failed — click to retry'}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-error/15 text-error ring-1 ring-inset ring-error/30 hover:bg-error/20 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">Update failed</span>
      </button>
    );
  }

  // status === 'ready'
  const version = updateInfo?.version ?? '';

  return (
    <AnimatePresence>
      <motion.button
        key="update-pill-ready"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: [0.9, 1.05, 1] }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.6, times: [0, 0.5, 1] }}
        onClick={() => void restart()}
        title={`Restart to install update v${version} — your terminals will be restored`}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-accent-primary/15 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <RotateCw size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">
          Relaunch <span className="opacity-70">·</span> v{version}
        </span>
      </motion.button>
    </AnimatePresence>
  );
}
```

Notes:
- The `no-drag` class is required because the title bar is a Tauri drag region and we don't want clicks to start a window drag.
- Heights match the rest of the title bar action cluster (24px pill vs 28px square buttons — the smaller height is intentional, the pill has a different visual weight).
- Tailwind tokens like `bg-accent-primary` and `text-error` are project conventions already used elsewhere in the title bar.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Standalone visual smoke test (component renders nothing yet — validated in Task 8)**

This task only creates the component. It isn't wired into `TitleBar` yet, so visually nothing changes. The next task wires it up and verifies it on screen.

- [ ] **Step 4: Commit**

```bash
git add src/components/UpdatePill.tsx
git commit -m "feat(updater): add UpdatePill component for title bar"
```

---

## Task 8: Render `UpdatePill` in the title bar

**Files:**
- Modify: `src/components/TitleBar.tsx`

- [ ] **Step 1: Import the pill**

In `src/components/TitleBar.tsx`, add to the imports near the top:

```tsx
import { UpdatePill } from './UpdatePill';
```

- [ ] **Step 2: Render `<UpdatePill />` as the first child of the right action cluster**

Find this block in `TitleBar.tsx` (around lines 298-315):

```tsx
{/* Right cluster — search, run, tool windows, settings, window controls */}
<div className="flex items-stretch">
  <div className="flex items-center gap-0.5 pr-2 no-drag">
    <button onClick={toggleChanges} className={iconBtn(changesOpen)} title="File Changes (F2)">
      <FileDiff size={15} strokeWidth={1.75} />
    </button>
```

Insert `<UpdatePill />` and a small spacer divider before the `<button onClick={toggleChanges} …>`:

```tsx
{/* Right cluster — search, run, tool windows, settings, window controls */}
<div className="flex items-stretch">
  <div className="flex items-center gap-0.5 pr-2 no-drag">
    <UpdatePill />
    <button onClick={toggleChanges} className={iconBtn(changesOpen)} title="File Changes (F2)">
      <FileDiff size={15} strokeWidth={1.75} />
    </button>
```

The pill returns `null` when status is anything other than `ready` or `error`, so it won't disturb layout in the normal case. Tailwind's `gap-0.5` between flex children means the pill is naturally spaced from the FileDiff button — no extra divider needed.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Manual verification of the ready-state pill**

This is the headline visual test.

1. Run `npm run tauri dev`.
2. Wait for the app to load.
3. Open DevTools console. Force the store into `ready` state for visual inspection:

   ```js
   useUpdaterStore.setState({
     status: 'ready',
     updateInfo: { version: '1.21.0', date: '', body: '' },
   });
   ```

   (If `useUpdaterStore` isn't accessible, use the temporary `__updater` global from Task 2.)

4. Confirm: a pill appears in the title bar between the project breadcrumb area and the FileDiff button. It reads `↻ Relaunch · v1.21.0`. It performs a one-time pulse animation on entry.
5. Hover the pill — tooltip shows `Restart to install update v1.21.0 — your terminals will be restored`.
6. Click the pill. The app should save session state and relaunch (a real `relaunch()` call). On a dev build with no real update staged this might error in the underlying updater — that's fine for this visual test; the click handler firing is what we're validating.
7. Reset the state: `useUpdaterStore.setState({ status: 'idle', updateInfo: null });` — pill disappears.
8. Force the error state:

   ```js
   useUpdaterStore.setState({
     status: 'error',
     error: 'Network unreachable',
   });
   ```

   Pill reappears as `⚠ Update failed`. Tooltip shows `Network unreachable`. Clicking it triggers a fresh `checkForUpdates`.
9. Reset again: `useUpdaterStore.setState({ status: 'idle', error: null });`.

Expected: both pill variants render correctly, tooltips are right, click handlers fire.

- [ ] **Step 5: Manual verification that no regression hit other states**

With `status: 'idle'`, `'checking'`, `'available'`, `'downloading'`, or `'up-to-date'`, the pill renders nothing. Cycle through these via `useUpdaterStore.setState({ status: 'checking' })` etc. and confirm the title bar is identical to before this change.

Expected: title bar layout is unchanged in non-pill states.

- [ ] **Step 6: Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat(updater): render UpdatePill in title bar right cluster"
```

---

## Task 9: End-to-end smoke test

**Files:** none

- [ ] **Step 1: Full happy-path verification**

1. With everything committed, run `npm run tauri dev`.
2. App loads → after ~3 seconds the startup check fires. With no real update staged, status will land at `up-to-date`. No pill, no banner. ✓
3. Open Settings → Updates panel. The existing UI still works (it's untouched). ✓
4. Close Settings.
5. In DevTools console, simulate the full lifecycle:

   ```js
   useUpdaterStore.setState({
     status: 'ready',
     updateInfo: { version: '1.21.0', date: '', body: 'Test release' },
   });
   ```

6. Confirm: title bar pill appears AND the existing post-download banner appears (because Task 4 wired the banner to `ready`). ✓
7. Dismiss the banner with its X button. Pill stays. ✓
8. Reset state. Pill disappears. ✓

- [ ] **Step 2: Verify build still produces installers**

Run: `npm run tauri build`
Expected: completes without TypeScript or Rust errors. Installer artifacts appear in `src-tauri/target/release/bundle/`.

(If a full installer build is too slow for an end-of-task gate, at minimum run `npx tsc --noEmit` and `npm run build` for the Vite frontend bundle to confirm no production-only issues.)

- [ ] **Step 3: No commit needed — this is a verification gate.**

---

## Self-Review

**Spec coverage:**

| Spec section | Task that covers it |
| --- | --- |
| Background scheduler — startup check (unchanged) | (no task — already exists) |
| Background scheduler — periodic 4h check | Task 5 |
| Background scheduler — focus re-check with 30-min floor | Task 6 |
| `lastCheckAt` field + drift guard | Tasks 2, 5, 6 |
| Silent auto-download on `available` | Tasks 1, 3 |
| Banner only auto-opens on `ready` | Task 4 |
| `UpdatePill` ready/error states + hidden in others | Task 7 |
| Pill placement before FileDiff in title bar | Task 8 |
| End-to-end edge case verification | Task 9 |

All spec sections covered.

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate" placeholders. Every code step shows the exact code. Manual verification steps spell out what to click and observe.

**Type consistency:** `UpdaterState.downloadAndInstall` signature in Task 1 (`(preFetched?: Update) => Promise<boolean>`) matches its call site in Task 3 (`get().downloadAndInstall(update)`). The `Update` import is added in Task 1 step 2. Constants `FOUR_HOURS_MS` and `THIRTY_MINUTES_MS` are defined in Tasks 5 and 6 respectively, both at module scope of `AutoUpdater.tsx` — no naming collisions. `UpdatePill` exports a named function matching the import in Task 8.
