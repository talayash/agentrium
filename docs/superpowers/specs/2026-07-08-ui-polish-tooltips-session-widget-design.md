# UI Polish: Styled Tooltips + Titlebar Session Widget

**Date:** 2026-07-08
**Goal:** Two visible touch-ups for the next release so the app feels newer: (1) replace native
`title=` tooltips in the always-visible chrome with the IntelliJ-style styled tooltip, (2) an
IntelliJ run-widget-style session switcher in the titlebar.

## Part 1 - Tooltip primitive

New `src/components/ui/Tooltip.tsx`:

- **API:** `<Tooltip label="Settings" shortcut="Ctrl+," side="top|bottom|left|right"><button/></Tooltip>`.
  Wraps a single child element; tooltip renders into `document.body` via `createPortal` so it is
  never clipped by `overflow`/`truncate` containers (titlebar, tab bar).
- **Behavior:** ~400 ms show delay; a shared module-level "warm" flag skips the delay when the
  pointer moves between adjacent tooltipped controls (IntelliJ behavior); hides instantly on
  leave/mousedown. Also shows on `focus-visible` for keyboard users.
- **Look:** `bg-elevation-3`, `ring-1 ring-[var(--ij-divider-soft)]`, rounded-md, 11.5 px
  `text-text-primary` label + `text-text-tertiary` shortcut chip - identical to the inline tooltip
  ToolStripe already renders.
- **Positioning:** pure function `computeTooltipPosition(anchorRect, tipSize, side, viewport)`
  in the same file (or `src/lib/`), clamped to the viewport - unit-testable without DOM.
- **A11y:** when the wrapped child has no visible text and no `aria-label`, Tooltip sets
  `aria-label={label}` so removing `title=` doesn't regress screen readers.

**Migration scope (this release, chrome only):** TitleBar, TerminalTabs, Sidebar, StatusBar,
TerminalStatusBar, ToolStripe (refactor its inline tooltip onto the primitive), UpdatePill,
ToolsMenu, RecentTerminalsMenu (see Part 2 - replaced), TerminalSearch, FileChangesPanel.
Settings pages and modals keep native `title=` for a later pass (~120 remaining sites).

## Part 2 - Session widget

`RecentTerminalsMenu` (titlebar right cluster) already implements most of the desired behavior
(state-sorted terminal dropdown, waiting-count badge, switch on click). To avoid duplicate
widgets, it is **replaced** by the new `src/components/titlebar/SessionWidget.tsx`, promoted to
the IntelliJ run-widget position:

- **Placement:** titlebar left cluster, after the branch switcher, behind the same divider style.
  Hidden entirely when no (non-script, non-shell) terminals exist.
- **Collapsed:** `StateDot` (live busy/waiting/idle/stopped) + active terminal nickname/label +
  chevron. Amber count badge when *other* terminals are in `waiting` state.
- **Dropdown:** styled like the branch menu (`bg-elevation-3`, ring, rounded-lg). One row per
  terminal - StateDot, name, state label, git branch (worktree-aware icon), dimmed working
  directory; active row highlighted with accent; click switches terminal. Sort: waiting first,
  then busy, then recency (reuse existing `STATE_ORDER` logic). Footer rows: **+ New Terminal**
  (opens NewTerminalModal) and **Open Command Palette for full search…** (kept from the old menu).
- **Interactions:** outside-click + Escape close (same pattern as branch menu). No filter input -
  the sidebar and command palette already cover search (YAGNI).
- `RecentTerminalsMenu.tsx` is deleted and its import removed from TitleBar.

## Non-goals

- Tooltip migration inside Settings pages / modals.
- Terminal actions (stop/restart) in the dropdown - explicitly deferred.
- Any behavior change to terminals themselves.

## Verification

- Unit tests: `computeTooltipPosition` (sides + viewport clamping), widget list
  sorting/waiting-count helpers if extracted.
- `npx tsc --noEmit`, `vite build`, existing vitest suite green.
- Visual check in the running dev app (port 5174).
