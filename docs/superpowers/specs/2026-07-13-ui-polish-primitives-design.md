# UI Polish v2 - Shared Primitives + Consistency Pass

**Date:** 2026-07-13
**Goal:** Close the remaining IntelliJ-fidelity gaps end-users notice - list-row
selection stripe, panel headers, per-panel progress, considered empty states -
by extending the `src/components/ui/` primitive set and migrating existing
panels/modals onto it. Purely visual and behavioral polish; no new features,
no color-scheme or font changes, no layout re-work.

## Non-goals

- **No** change to `--elevation-0…4`, `#3574F0` accent, Inter, or JetBrains Mono
- **No** change to `--ui-row-py/px` density tokens (compact/comfortable/spacious keep their current values)
- **No** re-layout of Sidebar/Explorer/Terminal grid - containers keep their current geometry
- **No** new features; behavior of every migrated component is preserved
- **No** tooltip migration inside Settings modals (~120 sites, deferred per the 2026-07-08 spec)
- **No** touchup to `xterm` content itself (terminal rendering is out of scope)

## Part 1 - New primitives

Four new components in `src/components/ui/`. Each is small, prop-driven, and
inherits the existing focus-ring cascade from `index.css`. Where a primitive
has non-trivial branching logic (currently only `ProgressStripe`), that logic
is extracted to `src/lib/<name>.ts` and unit-tested there, matching the
existing codebase style (see `tooltipPosition.test.ts`). The rest is visual
polish - verified in the running dev app, not in a rendered-component test
(this repo does not use `@testing-library/react`).

### 1.1 `ListRow`

The canonical selectable list-item. Replaces the ad-hoc
`<button className="w-full ... hover:bg-white/[0.045] ...">` blocks scattered
across `SessionsPanel`, `SessionHistory`, `FileTreePanel`, `WorktreeModal`,
`SnippetsModal`, and the branch dropdown in `TitleBar`.

**API:**

```tsx
<ListRow
  selected={boolean}
  onClick={() => void}
  onContextMenu={(e) => void}
  leading={<Icon />}                // optional
  trailing={<span>meta</span>}      // optional right-aligned slot (kbd, count, date)
  disabled={boolean}
  as="button" | "div"               // default 'button'
  variant="default" | "compact"     // 'compact' = 22px, 'default' = 26px
  ariaLabel={string}
  className={string}
>
  {/* row body - usually a name + badges */}
</ListRow>
```

**Look:**

- Height: 26 px (`default`), 22 px (`compact`). Both respect `--ui-row-py/px`
  via the shared spacing utilities - density still cascades.
- Idle: `text-text-primary`, no background.
- Hover: `bg-white/[0.045]` (matches existing pattern).
- **Selected: `bg-accent-primary/12` + a 2 px left stripe (`::before`,
  `bg-accent-primary`, `top: 3px; bottom: 3px; border-radius: 0 2px 2px 0`).**
  The stripe is the visual anchor missing today - every IntelliJ tool window
  uses one.
- Focus (keyboard): the global `:focus-visible` outline still applies; the
  selected stripe is orthogonal to focus.
- Disabled: `opacity-50 cursor-default`.
- Reduce-motion: no override needed; row-level transitions are already
  `transition-colors` which the global reduce-motion cascade neutralizes.

### 1.2 `PanelHeader`

The 26 px header strip used at the top of every tool window
(SessionsPanel, FileChangesPanel, FileTreePanel, WorktreeModal, etc.). Today
these headers all diverge slightly - some 30 px, some 26 px, uppercase title
here, sentence case there, different action-button paddings. `PanelHeader`
converges them.

**API:**

```tsx
<PanelHeader
  title="Sessions"
  count={4}                              // optional trailing count
  collapsible={boolean}                  // renders a chevron on the left; defaults to false
  collapsed={boolean}                    // controlled
  onToggleCollapsed={() => void}
  actions={<><IconButton .../><IconButton .../></>}   // right-slot
  progress={<ProgressStripe indeterminate />}          // optional (see 1.3)
/>
```

**Look:**

- Height 26 px, `bg-elevation-1`, bottom border `border-[var(--ij-divider-soft)]`.
- Title: 11 px, `font-semibold`, `uppercase`, `tracking-[0.06em]`,
  `text-text-secondary` - same treatment as the existing Sidebar "PROJECT"
  header, promoted to a primitive.
- Count: 10.5 px, tabular-nums, `text-text-tertiary`, non-uppercase.
- Actions slot: right-aligned, small icon buttons (20 × 20 px, 3 px radius,
  hover `bg-white/[0.06]`). Uses a nested `IconButton` sub-primitive
  (defined in the same file - not exported separately, YAGNI).
- Progress slot: renders a `ProgressStripe` immediately below the header row,
  overlapping the bottom border by 1 px so the border becomes the progress
  bar's rail when active. Zero-height when not passed → no layout shift.

### 1.3 `ProgressStripe`

Thin (2 px) indeterminate or determinate bar. Used inside `PanelHeader.progress`
today; can later be dropped anywhere a panel needs "work in progress" feedback
(LSP starting, git fetching, session polling).

**API:**

```tsx
<ProgressStripe />                    // indeterminate (default)
<ProgressStripe value={0.62} />       // determinate, 0..1
<ProgressStripe hidden />             // reserves the 2 px so layout doesn't jump
```

**Look:**

- Height 2 px, transparent track.
- Indeterminate: a 30% wide gradient bar slides left→right on a 1.4 s loop,
  color `--accent-primary`. Neutralised by reduce-motion (bar becomes a
  static 30% width instead of animating).
- Determinate: filled bar from `0..value`, no animation.
- Never renders shadow/glow - the stripe is a rail, not a chrome element.

### 1.4 `EmptyState`

Centered vertical stack for empty lists. Replaces the current one-line
`text-text-tertiary` "No X yet" placeholders - sober but considered.

**API:**

```tsx
<EmptyState
  icon={<Terminal />}                    // Lucide icon, sized ~24 px
  title="No terminals yet"
  description="Create a Claude Code session to start working on a project."
  action={<Button variant="primary" size="sm" icon={<Plus />}>New Terminal</Button>}   // optional
/>
```

**Look:**

- Vertical stack, `padding: 32px 24px`, `gap-2`.
- Icon: 32 × 32 px container, `color: text-text-tertiary`, no background.
- Title: 13 px, `text-text-primary`, `font-medium`.
- Description: 12 px, `text-text-tertiary`, `max-width: 220px`, `line-height: 1.5`.
- Action: renders whatever `Button` is passed; primary/sm/plus-icon is the
  recommended composition.
- Alignment: centered when the container is ≥ 200 px tall, top-aligned
  otherwise (small panels use the same primitive without wasting height).

## Part 2 - Migration map

Each row: **surface → primitive(s) it adopts → what changes visibly**.

| Surface | Primitive(s) | Visible change |
| --- | --- | --- |
| `SessionsPanel` header + rows | `PanelHeader`, `ListRow`, `EmptyState`, `ProgressStripe` (when `loading`) | Rows gain the accent stripe on the active session; header count becomes consistent; empty-repo state is a considered stack; refresh spinner promoted to the panel-level `ProgressStripe`. |
| `FileChangesPanel` group headers + rows | `ListRow` for change rows; keep the current bespoke section headers (they carry too much unique logic - commit/push/stash - to fold into `PanelHeader` right now). | Selected change row gets accent stripe; hover consistency across the panel. |
| `FileTreePanel` header + rows | `PanelHeader`, `ListRow (compact)` | Header height unifies; tree rows get consistent hover; selected file gets accent stripe. |
| `Sidebar` outer "PROJECT" header | `PanelHeader` | Same look, but centralised. |
| `WorktreeModal` list | `ListRow`, `EmptyState` | Row stripe for selected; "no worktrees" becomes the empty state. |
| `SnippetsModal` list | `ListRow`, `EmptyState` | Row stripe for selected; empty search state uses `EmptyState`. |
| `TitleBar` branch dropdown | `ListRow (compact)` | Row stripe for current branch (replacing the current `text-accent-primary bg-accent-primary/10`). |
| `SessionWidget` dropdown | `ListRow (compact)` | Same. |
| `NewTerminalModal` recent/profile list | `ListRow`, `EmptyState` | Row stripe on hover-selected suggestion; empty search state. |
| `ProfileModal` profile list | `ListRow`, `EmptyState` | Same. |
| `SessionHistory` rows | `ListRow (compact)` | Same. |
| `StatusBar` | - (see Part 3) | Adds notification bell + unread dot; can host a `ProgressStripe` above the bar during LSP startup / global git operations (opt-in only, off by default). |

`ChangelistSection` inside `FileChangesPanel` is intentionally **not migrated**
- its collapsible group + drag-drop staging targets are load-bearing and
inline-only. Extracting them would fight the primitive.

## Part 3 - StatusBar additions

Two small end-user-visible additions:

1. **Notification bell (already present)** - augmented with an unread dot
   (2 px accent circle at top-right of the bell glyph) that appears when a
   terminal finished while the app was un-focused and the notification event
   has not been acknowledged. Clicking the bell clears the dot. State lives
   in `appStore` (`unreadNotificationCount: number`, incremented by the
   existing `terminal-finished` listener when `document.hidden`).

2. **Global progress stripe (opt-in)** - a 2 px `ProgressStripe` rendered
   above the status bar's border, driven by a new `appStore.globalBusy: string
   | null` flag. Only two hooks light it up: LSP startup (already emits an
   event via the LspManager), and long-running git fetch/pull operations
   (already track their `loading` state locally - publish it up to the store).
   Hidden by default so existing users see zero visual delta unless one of
   those hooks fires.

## Part 4 - Motion polish delta

Small, additive changes to the shared motion behaviour:

- **Modal open** - already uses `dialogMotion` (`scale 0.98 → 1 + fade`,
  120 ms). Verify every modal that currently doesn't use the `Modal`
  primitive is migrated in this pass (audit: grep for `motion.div … role="dialog"`
  outside `Modal.tsx`).
- **"Just-finished" tab flash** - when a terminal transitions from `busy` →
  `idle`, its tab's bottom underline flashes `--success` for 800 ms then
  fades back. Implemented as a new keyframe `ct-tab-finish` in
  `index.css`, added to the tab element via a data attribute the poller
  sets and clears. Reduce-motion falls back to a static 800 ms color change.
- **Tab close-x reveal** - already present (`opacity-0 group-hover:opacity-100`).
  Keep; verify all three "action" icons inside the tab (split, duplicate,
  add-to-grid) share the same reveal pattern.
- **Notification-bell unread pulse** - the dot pulses (0.9 → 1.0 opacity,
  1.4 s) once, then goes static, matching the existing `ct-pulse-dot`
  keyframe but running once. Reduce-motion: static from frame 1.

## Part 5 - File structure

New files:

```
src/components/ui/
  ListRow.tsx
  PanelHeader.tsx
  ProgressStripe.tsx
  EmptyState.tsx
src/lib/
  progressStripe.ts       + progressStripe.test.ts
```

Modified files (migration):

- `src/components/SessionsPanel.tsx`
- `src/components/FileChangesPanel.tsx`
- `src/components/FileTreePanel.tsx`
- `src/components/Sidebar.tsx`
- `src/components/WorktreeModal.tsx`
- `src/components/SnippetsModal.tsx`
- `src/components/TitleBar.tsx`
- `src/components/titlebar/SessionWidget.tsx`
- `src/components/NewTerminalModal.tsx`
- `src/components/ProfileModal.tsx`
- `src/components/SessionHistory.tsx`
- `src/components/StatusBar.tsx`
- `src/store/appStore.ts` (adds `unreadNotificationCount`, `globalBusy`)
- `src/index.css` (adds the `ct-tab-finish` keyframe)

No files are deleted.

## Verification

- `npx tsc --noEmit` - clean.
- `npm run build` - clean.
- Vitest - all existing suites plus the new `progressStripe.test.ts` green.
- Manual visual check in `npm run tauri dev` (port 5174):
  1. Open Sessions panel with a folder that has ≥ 1 saved session - active
     session row shows the 2 px accent stripe on the left.
  2. Empty a Snippets modal (search for a nonsense string) - empty state
     renders centered with a muted icon.
  3. Start LSP by opening a `.ts` file - status bar's `ProgressStripe`
     appears above the border, disappears when LSP is ready.
  4. Finish a Claude session - the corresponding tab flashes green for
     ~800 ms then returns to its idle color.
  5. Trigger `terminal-finished` while the app is unfocused - the
     status-bar notification bell shows a dot; clicking clears it.
- Reduce-motion: enable `prefers-reduced-motion` (or the in-app toggle) and
  verify none of the new animations play - stripes are static, tab flash is
  a plain color change, unread pulse is a static dot.

## Rollout

Single PR / single release (target v1.28.0). No feature flag - this is
purely visual polish; there's no user-facing setting to expose.
