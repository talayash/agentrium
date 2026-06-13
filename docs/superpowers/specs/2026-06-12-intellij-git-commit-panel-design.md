# IntelliJ-style Git Commit Panel — Design

Date: 2026-06-12
Status: approved-by-request (user supplied IntelliJ IDEA Commit tool window screenshot as the target; "identical to IntelliJ IDEA Git, rename to Git, no Shelf tab")

## Goal

Restyle the right-side **File Changes** panel to match the IntelliJ IDEA 2026 Commit
tool window, renamed to **"Git"**, without the Shelf tab.

## What changes

### Naming
- Panel header, ToolStripe rail button, Command Palette entry, and keymap label all
  say **Git** instead of **File Changes** (shortcut stays F2).
- Header shows an IntelliJ-style active **Commit** tab chip (no Shelf tab).

### Changes tree (replaces the Staged / Unstaged split)
- Single tree under a "Changes" header, IntelliJ checkbox model:
  - Changelist group rows rendered as `[Name] N files` with a tri-state checkbox
    and the repo branch as a gray badge (like `stage-israir` in the reference).
  - File rows: checkbox · file icon · basename colored by git status · dim
    directory path to the right (IntelliJ layout).
- **Checkbox = staged.** Checking a file runs `git add`; unchecking runs unstage.
  A file that is partially staged shows an indeterminate checkbox; clicking it
  stages the remainder. Group checkboxes stage/unstage the whole group.
- Row click selects the row (blue selection like IntelliJ) and toggles the inline
  diff underneath (existing behavior preserved). Hover actions: open diff in
  editor, discard. Right-click context menu still moves files between changelists.
- Changelists (create/rename/delete) keep working; the default list renders as
  `[Default]`.

### Commit area (bottom, matches reference)
- **Amend** checkbox row with the last commit subject in gray ("last commit").
  Toggling Amend on with an empty message pre-fills the last commit message.
- Larger flat commit-message box (placeholder "Commit Message").
- Button row: primary **Commit**, bordered **Commit and Push…**, and a kebab menu
  holding **Stash Changes** (stash moves out of the main row).
- Commit commits the checked (= staged) files; disabled when nothing is checked
  unless Amend is on.

### Kept as-is (out of IntelliJ scope but existing features)
- Repositories section (branch switcher, pull, pin, open-shell, worktrees).
- Stashes list, footer path info, auto-refresh, push/pull header actions
  (restyled as toolbar icons).

## Backend
- `git_commit` gains optional `amend: bool` (default false) → `git commit --amend
  -F <file>`; the "nothing staged" guard is skipped when amending.
- New command `get_last_commit_info(path) -> Option<{subject, message}>` using
  `git log -1 --format=%s%x1f%B`; returns `None` for repos with no commits.

## Files touched
- `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`
- `src/components/FileChangesPanel.tsx` (header, tree integration, commit area)
- `src/components/ChangelistSection.tsx` (becomes the full checkbox tree)
- `src/components/ToolStripe.tsx`, `src/components/CommandPalette.tsx`,
  `src/lib/keymap.ts` (rename)
