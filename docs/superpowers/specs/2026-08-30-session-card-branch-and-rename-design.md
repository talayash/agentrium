# Session Card: Show Git Branch and Enable Rename

Date: 2026-08-30
Scope: `src/components/SessionCards.tsx` only. No backend changes.

## Problem

The Sessions sidebar card (screenshot: "Claude Terminal 1" / "claude-terminal") is missing two things users expect from a modern tabbed terminal:

1. **No visible current git branch.** Users have to look up at the titlebar's branch switcher or read the status bar to know which branch a session is on. When several sessions share the same repo but different worktrees/branches, the card alone can't tell them apart.
2. **No way to rename a card.** The store already ships `updateNickname` (wired to `update_terminal_nickname`), but there is no UI trigger. Users are stuck with the profile-derived `label`.

## Solution

Reuse the existing plumbing. Both features are UI-only in `SessionCards.tsx`.

### 1. Branch chip on the card

Extend the second row (currently: `basename(cwd)` on the left, `cost` on the right) to also render a branch chip between the directory and the cost, when a branch is known.

Data source: `useTerminalStore((s) => s.gitInfoCache).get(id)` - already populated by `fetchGitInfo` at terminal creation. No new fetch, no new IPC.

Rendering rules:
- Only render when `gitInfo.is_git_repo && gitInfo.current_branch`.
- Icon: `GitFork` (worktree) or `GitBranch` (main). Size 10 px, `text-text-tertiary`.
- Label: `gitInfo.current_branch`, truncated to `max-w-[100px]` so a very long branch name doesn't push the cost off-row.
- Styling: `text-[11px] text-text-tertiary` to match the sibling `dir` span.
- Layout: `dir` and branch sit in a `flex items-center gap-2` group on the left; `cost` keeps `ml-auto`.

This mirrors the pattern already used in `SessionWidget.tsx:143-148`, so both places look the same and stay consistent.

### 2. Rename the card (double-click + context menu)

Backend: reuse `updateNickname(id, nickname)` from the terminal store. `nickname` is the correct field - the display name is already `nickname || label`, and the profile-derived `label` should stay immutable.

Two triggers (Option C from brainstorming):

**Trigger A - Double-click the name span.**
- `onDoubleClick` on the name span swaps the span for an `<input>` inline.
- Input mounts with the current `nickname || label` pre-selected.
- Enter or blur commits (only if the value changed, and only if trimmed non-empty).
- Escape reverts and closes.
- Empty submit clears the nickname (falls back to the profile `label`), so users can undo a rename.
- While editing: `e.stopPropagation()` on the input's mouse/keyboard events so clicks don't set the card active or trigger drag-reorder.

**Trigger B - Context menu "Rename..." as the first entry.**
- Adds a `CardMenuItem` with a `Pencil` icon at the top of the existing menu (above the current "Pin" item).
- Selecting it puts the same card into inline-edit mode (shares the state used by Trigger A).

Editing state lives in local component state, keyed by the id currently being renamed:
```ts
const [renamingId, setRenamingId] = useState<string | null>(null);
```
Only one card can be in edit mode at a time.

### Interactions to preserve

- Drag-reorder must not fire while renaming. The `Reorder.Item` should have `drag={renamingId !== id}` (Framer supports a boolean here) to disable drag on the card being edited.
- Middle-click close and right-click menu remain wired on the card container - but the input inside stops propagation so those don't fire from within the input.
- Active-card selection: the input's clicks/keys shouldn't call `setActiveTerminal`. Card-level `onClick` already fires from the container; the input just stops that path.

## Non-goals

- No new IPC command.
- No changes to `label` (still profile-derived at spawn).
- No branch display or rename affordance on the top tab strip / titlebar - that surface already has a branch switcher above and the design comment at `TerminalTabs.tsx:175` explicitly rejects a third branch copy.
- No rename in the grid, split, or bottom-shell views. Sidebar card only.
- No branch refresh on demand. `fetchGitInfo` runs at terminal creation; a periodic refresh is out of scope for this change. (If it turns out to be missed, that's a follow-up.)

## Testing

Unit-level (Vitest + React Testing Library):
- Card renders branch chip when `gitInfoCache` has `is_git_repo: true` and `current_branch: "master"`.
- Card does not render branch chip when `is_git_repo: false` or `current_branch: null`.
- Worktree case renders `GitFork`, non-worktree renders `GitBranch`.
- Double-clicking name enters edit mode; typing + Enter calls `updateNickname` with the new value.
- Escape while editing reverts and closes without calling `updateNickname`.
- Empty submit calls `updateNickname` with empty string (clears nickname).
- Context menu "Rename..." puts the same card into edit mode.
- Drag is disabled on the card being renamed.

Manual smoke:
- Rename a session, close the app, reopen: nickname persists (backend already handles this via the SQLite `session_history` path).
- Rename to the same value: no IPC fires (guard in the submit handler).

## Files touched

- `src/components/SessionCards.tsx` - the whole change lives here.
- `src/components/SessionCards.test.tsx` if it exists, otherwise a new file if we already have a co-located test convention. (Verify at plan-time.)

No other files need to change.
