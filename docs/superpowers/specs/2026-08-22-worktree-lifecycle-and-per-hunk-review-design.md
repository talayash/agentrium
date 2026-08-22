# Worktree Lifecycle + Per-Hunk Accept/Reject

**Date:** 2026-08-22
**Goal:** Close two rough edges in the existing worktree + diff review flow: (1) app-created worktrees leak on close; (2) the diff panel is read-only. Add a close-time lifecycle modal for worktree-isolated terminals and per-hunk accept/discard controls in the inline diff view.

## Overview

ClaudeTerminal has already built worktree isolation and inline diff rendering. This spec is an additive "review polish" pass. No component rewrites. No new subsystems.

Two coordinated tracks:

**Track A: Worktree Lifecycle.** When a terminal that owns an app-created worktree closes, a modal offers four actions: merge (fast-forward only), squash-merge with editable message, keep, or discard. This closes off the "worktree leak" problem where isolated sessions accumulate `../foo-claude/*` dirs.

**Track B: Per-Hunk Accept/Reject.** Each hunk in the existing `InlineDiffView` gets ✓ and ✕ icon buttons in its header. ✓ stages the hunk via `git apply --cached`. ✕ discards it via `git apply -R` (destructive on working tree). A 5s bottom-of-panel undo toast provides recovery. Rejecting a hunk with more than 20 net change lines requires a one-click inline confirm.

The two tracks are packaged as one spec because they share the theme "review Claude's work" and land close together, but they touch different code paths and can be built in either order.

## Architecture

Pure additive. No file removals. New DB table, new components, new backend commands.

```
Track B (per-hunk):
  InlineDiffView renders hunk -> user clicks ✓ or ✕
    |
    v
  invoke('stage_hunk' | 'discard_hunk', {repo, file, hunk_patch})
    |  (patch text: content-addressed, no index arithmetic)
    v
  git apply --cached | -R  (context match enforced by git)
    |
    +-- success -> hunkUndoStore.push(action) -> HunkActionToast (5s undo)
    |                    |
    |                    v
    |            polling refresh removes hunk from view
    |
    +-- error ---> user_err (no telemetry) -> toast + panel refresh

Track A (worktree lifecycle):
  user closes worktree-isolated terminal
    |
    v
  terminalStore.closeTerminal(id)
    |
    +-- has app_worktrees row? -> WorktreeCloseModal
    |        |
    |        v
    |   user picks 1 of 4:
    |        Merge    -> merge_worktree_ff(path, base)
    |        Squash   -> squash_merge_worktree(path, base, msg)
    |        Keep     -> no-op, close terminal
    |        Discard  -> discard_worktree(path)
    |
    +-- no row -> close terminal silently (unchanged behavior)
```

## New files

| Path | Purpose |
|---|---|
| `src/components/WorktreeCloseModal.tsx` | Modal with 4 lifecycle actions, ahead/dirty summary, squash message textarea, "remember for profile" checkbox |
| `src/components/HunkActionToast.tsx` | Sticky-bottom undo toast, action coalescing, inline confirm bar for >20-line rejects |
| `src/store/hunkUndoStore.ts` | Zustand slice, ephemeral, 5s timer, LIFO undo stack |
| `src-tauri/src/hunk_ops.rs` | New Rust module: hunk-patch normalization, `git apply` wrapper, worktree lifecycle git ops |
| `src/store/hunkUndoStore.test.ts` | Vitest coverage of the undo store |
| `src/components/InlineDiffView.hunkActions.test.tsx` | Vitest for the new hunk button interactions |
| `src/components/WorktreeCloseModal.test.tsx` | Vitest for the modal flow |

## Modified files

| Path | Change |
|---|---|
| `src/components/InlineDiffView.tsx` | Add ✓/✕ icon group in the hunk header row (right-aligned). Wire to hunkUndoStore. Suppress buttons on binary/new/deleted files per `FileDiffResult` flags. |
| `src/components/FileChangesPanel.tsx` | Mount `HunkActionToast` at the bottom edge; on hunk action, trigger an immediate refresh (bypass the 5s tick). |
| `src/store/terminalStore.ts` | `closeTerminal(id)`: check for `app_worktrees` row before calling backend close. If present, open modal first and await resolution. |
| `src/App.tsx` | Mount `<WorktreeCloseModal/>` at the app root, driven by `appStore` state set by `terminalStore.closeTerminal`. |
| `src-tauri/src/commands.rs` | Add new `#[command]` handlers: `stage_hunk`, `discard_hunk`, `merge_worktree_ff`, `squash_merge_worktree`, `discard_worktree`, `get_app_worktree`. All go through `wrap_cmd(...)`. Update `create_terminal` to accept an optional `worktree_link` param and insert the `app_worktrees` row atomically when present. |
| `src-tauri/src/database.rs` | Migration: `CREATE TABLE IF NOT EXISTS app_worktrees`. Add startup cleanup pass to remove rows whose `worktree_path` no longer exists. |
| `src-tauri/src/config.rs` | Add `worktree_close_default: Option<WorktreeCloseAction>` field to `ConfigProfile` (nullable, `#[serde(default)]`). New enum `WorktreeCloseAction` in same file. |
| `src-tauri/src/main.rs` | Register new commands in `invoke_handler`. Wire `hunk_ops` module. |
| `src/changelog.json` | Add release notes entry for both features. |

## Data model

### New table: `app_worktrees`

```sql
CREATE TABLE IF NOT EXISTS app_worktrees (
  terminal_id   TEXT PRIMARY KEY,
  worktree_path TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

Field notes:
- `terminal_id`: the UUID used by `TerminalManager` in memory. Not a FK because terminals are ephemeral.
- `worktree_path`: absolute path to the worktree; matches `git worktree list`.
- `base_branch`: what the modal defaults the merge target to. Captured at creation.
- `branch_name`: the worktree's own branch. Needed for `git branch -D` on discard.
- `created_at`: unix seconds. Informational.

Inserted atomically by `create_terminal` when the frontend passes an optional `worktree_link` payload (`{worktree_path, base_branch, branch_name}`). The `create_worktree` command itself does not touch this table, because it runs *before* the terminal exists (the terminal_id is not known yet).

Deleted by:
- `merge_worktree_ff`, `squash_merge_worktree`, `discard_worktree` on success (atomic with the git op).
- `close_terminal` for terminals where the modal resolved with "Keep" but the user later closes for real (row is left in place if Keep was picked; only fully removed when the worktree itself is gone).
- Startup cleanup for rows whose `worktree_path` no longer exists on disk.

The frontend consults `get_app_worktree(terminal_id) -> Option<AppWorktreeRow>` (small new query helper) before opening the modal.

### `ConfigProfile` addition

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeCloseAction {
    Merge,
    Squash,
    Keep,
    Discard,
}

pub struct ConfigProfile {
    // existing fields
    #[serde(default)]
    pub worktree_close_default: Option<WorktreeCloseAction>,
}
```

Existing profile blobs deserialize as `None` (means "always show modal").

### `hunkUndoStore` (frontend)

```ts
type HunkAction = {
  kind: 'stage' | 'discard';
  repoPath: string;
  filePath: string;
  hunkPatch: string;
  timestamp: number;
};

type UndoResult = { ok: number; failed: number };

interface HunkUndoState {
  stack: HunkAction[];
  push: (a: HunkAction) => void;
  undoAll: () => Promise<UndoResult>;
  clear: () => void;
}
```

5s timer is a `setTimeout` reset on every `push`. On timeout, `clear()` runs. Store lives in Zustand (outside the component tree) so polling refresh does not wipe it.

## Backend commands

### Track B: hunk operations

Both commands take the exact hunk-as-patch text. Context matching by git enforces safety on stale hunks.

```rust
#[tauri::command]
pub async fn stage_hunk(
    state: State<'_, AppState>,
    repo_path: String,
    file_path: String,
    hunk_patch: String,
) -> Result<(), String>;

#[tauri::command]
pub async fn discard_hunk(
    state: State<'_, AppState>,
    repo_path: String,
    file_path: String,
    hunk_patch: String,
) -> Result<(), String>;
```

Implementation:
- `normalize_hunk_patch(file_path, hunk_patch)`: prepends the minimal file header (`diff --git a/... b/...`, `--- a/...`, `+++ b/...`) if the caller sent only the raw hunk. Idempotent when the header is already present.
- `run_git_apply(repo, patch, extra_args)`: pipes normalized patch to `git -C <repo> apply <extra_args>` via stdin. Returns `Ok(())` on exit 0. Non-zero exit reports the git stderr via `error_reporter::user_err`.

Undo (client-invoked reverse) uses the same commands with the opposite `extra_args`: `["-R", "--cached"]` for undoing stage, `[]` for undoing discard.

### Track A: worktree lifecycle

```rust
#[derive(Serialize)]
pub struct MergeResult {
    pub new_head_sha: String,
    pub deleted_worktree_path: String,
}

#[tauri::command]
pub async fn merge_worktree_ff(
    state: State<'_, AppState>,
    worktree_path: String,
    base_branch: String,
) -> Result<MergeResult, String>;

#[tauri::command]
pub async fn squash_merge_worktree(
    state: State<'_, AppState>,
    worktree_path: String,
    base_branch: String,
    message: String,
) -> Result<MergeResult, String>;

#[tauri::command]
pub async fn discard_worktree(
    state: State<'_, AppState>,
    worktree_path: String,
) -> Result<(), String>;
```

All three:
1. Resolve `main_repo_path` from `get_worktree_info(worktree_path)`.
2. For merge/squash: `git -C main_repo_path fetch --quiet` if base has upstream, else skip.
3. For merge/squash: `git -C main_repo_path checkout <base_branch>`. Refuse if main checkout is dirty (return user_err).
4. Merge: `git -C main_repo_path merge --ff-only <wt_branch>`. Error on non-FF or conflict.
5. Squash: `git -C main_repo_path merge --squash <wt_branch>`, then `git commit -m <message>`.
6. On success of merge/squash: `git worktree remove <worktree_path>`. For squash, also `git branch -D <wt_branch>` (safe because squash preserved the work into base).
7. Discard: `git worktree remove --force <worktree_path>`, then `git branch -D <branch_name>`.

All errors flow through `error_reporter::user_err` (env-driven, telemetry skipped) per the project rule.

Each lifecycle command deletes the corresponding `app_worktrees` row atomically as its final step on success. Frontend does not manage this table directly.

Additional small helper:

```rust
#[tauri::command]
pub async fn get_app_worktree(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<AppWorktreeRow>, String>;
```

Used by `terminalStore.closeTerminal` to decide whether to open the modal.

## UI details

### `WorktreeCloseModal`

Header: `Session done on <branch-name>` with an info icon.
Summary line: `N commits ahead of <base> · W uncommitted changes` (fetched from `get_worktree_info`).

Four buttons stacked vertically, ~360px wide modal:

1. Primary (accent-primary bg): `Merge to <base>, then delete worktree`
2. Secondary outline: `Squash-merge, tidy commit, then delete`
3. Ghost: `Keep worktree, I'll deal with it`
4. Danger (red outline): `Discard branch + delete worktree`

Below the buttons: checkbox `Remember for the "<profile-name>" profile` (unchecked by default; writes `worktree_close_default` on close).

Squash click expands an inline textarea:
- Prefilled: branch name as commit subject, then `- <commit-subject>` lines from `git log --format="- %s" <base>..HEAD`.
- Confirm button below textarea; Cancel returns to the button list.

Uses existing `Modal` component pattern (see `NewTerminalModal` for reference). Close-on-scrim-click is disabled to prevent accidental dismissal.

### Hunk header buttons in `InlineDiffView`

The existing hunk header line gets a right-aligned `<div class="hunk-actions">` with two 20x20px icon buttons:

- ✓: `bg-success/10 hover:bg-success/20 ring-1 ring-success/30`, Check icon. Tooltip: "Stage hunk".
- ✕: `bg-error/10 hover:bg-error/20 ring-1 ring-error/30`, X icon. Tooltip: "Discard hunk".

Visibility rule: buttons render only when `!fileDiff.is_binary && !fileDiff.is_new_file && !fileDiff.is_deleted_file`. Renamed-with-content files show hunk buttons on the content hunks; the rename itself is covered by the existing file-level action.

Click ✓: invoke `stage_hunk` with `hunk_patch = reconstruct(hunk)`. On success: `hunkUndoStore.push({kind: 'stage', ...})`, immediate refresh via `FileChangesPanel.forceRefresh()`.

Click ✕: if `netChangeCount(hunk) <= 20`, proceed like ✓ but with kind 'discard'. If > 20, replace the hunk header buttons with an inline confirm bar:

```
@@ -100,50 +100,50 @@ fn()   Really discard 47 lines?  [ Cancel ] [ Discard ]
```

`netChangeCount = count(lines starting with '+') + count(lines starting with '-')`. 5s auto-timeout returns to normal state (Cancel is the default). Cancel: revert to buttons. Discard: proceed with the invoke.

### `HunkActionToast`

Sticky at the bottom of `FileChangesPanel`, above the panel border. Slides in from below on push.

Single-action content: `Staged hunk @L<line> · Undo (Xs)` with a thin progress-bar underline for the countdown.
Coalesced content when kinds match: `Staged N hunks · Undo all (Xs)`.
Coalesced content when mixed: `Actioned N hunks · Undo all (Xs)`.

Undo button click: pops the entire stack, calls the appropriate reverse invoke for each (LIFO). Returns `{ok, failed}`; if `failed > 0`, replace toast with `Undone K of N. J hunks changed since (context mismatch).` for 3s, then dismiss.

Timer: `setTimeout(clear, 5000)` reset on every `push`. On timeout, no git action taken (state is already correct); toast slides out.

## Interactions with existing behaviors

**File-level checkbox** (existing per-file accept/reject): unchanged. When a file has some hunks staged and some not, the checkbox shows indeterminate. Clicking file-level accept stages all remaining hunks via the existing per-file backend command; that path does not use the hunk undo stack.

**Changelists** (`changelists.rs`): unchanged. Hunk-level actions flow through the file's existing changelist assignment for commit organization.

**5s polling** in `FileChangesPanel`: unchanged. After a hunk action, an immediate refresh is triggered so vanished hunks are gone within ~100ms. Between ticks, new Claude edits still take up to 5s to appear.

**Terminal close flow** (existing `terminalStore.closeTerminal`): now consults `app_worktrees` before invoking backend close. If a row exists, opens `WorktreeCloseModal` and awaits resolution before proceeding to backend `close_terminal`. If not, unchanged.

## Migration and rollout

- **DB migration:** `CREATE TABLE IF NOT EXISTS app_worktrees ...` on `Database` init. Non-destructive; safe on all existing installs.
- **Startup cleanup:** on app boot, before user sees the UI, delete `app_worktrees` rows where `worktree_path` no longer exists. One-shot check.
- **Existing worktrees:** worktrees on disk before this feature ships have no `app_worktrees` rows. They will not trigger the modal, which is the safe default. A "Adopt existing worktrees" follow-up is out of scope.
- **Profile migration:** `worktree_close_default` is `Option<T>` with `#[serde(default)]`. Existing profile blobs load as `None`.
- **Feature flag:** none. Additive UI on an existing feature.
- **Release notes** (`src/changelog.json`):
  - "Per-hunk accept and discard in the file changes panel"
  - "Worktree lifecycle: on close, choose merge, squash, keep, or discard"

## Testing plan

### Backend (Rust unit tests)

Scratch git repos via `tempfile::TempDir`. Each test builds a known state, runs the command, asserts git state.

- `stage_hunk`
  - Happy: single-hunk patch on a modified file. Verify `git diff --staged` output.
  - Multi-hunk file: stage hunk 2 of 3. Verify hunks 1 and 3 remain unstaged.
  - Stale hunk (context mismatch): expect error, no state change.
- `discard_hunk`
  - Happy: file reverts to pre-hunk state.
  - Discard added lines: file loses them.
  - Discard removed lines: file regains them.
  - Stale: expect error, no state change.
- `merge_worktree_ff`
  - Happy: FF succeeds, base advances, worktree removed.
  - Base dirty in main checkout: error, no side effects.
  - Not FF-able (base moved): error, worktree preserved.
- `squash_merge_worktree`
  - Happy: 3 commits squashed with custom message; worktree and branch cleaned.
  - Conflict: error, branch and worktree preserved.
  - Empty message: error at backend layer.
- `discard_worktree`
  - Happy: dirty worktree + unmerged branch, both removed.
  - Missing worktree path: idempotent no-op.

### Frontend (Vitest + React Testing Library)

- `hunkUndoStore` (`src/store/hunkUndoStore.test.ts`)
  - Push once, undo restores via mocked invoke.
  - Push twice within 5s: coalescing; undoAll reverses LIFO.
  - Timeout clears the stack.
  - Partial failure returns `{ok, failed}` correctly.
- `InlineDiffView.hunkActions` (`src/components/InlineDiffView.hunkActions.test.tsx`)
  - Renders ✓/✕ on a text hunk.
  - Suppresses ✓/✕ on binary / new / deleted (via mocked `FileDiffResult` flags).
  - Click ✓ calls `invoke('stage_hunk', ...)` with the exact hunk patch string.
  - Click ✕ on ≤20-line hunk: immediate; on >20: confirm bar. Cancel restores; Discard fires the invoke.
- `WorktreeCloseModal` (`src/components/WorktreeCloseModal.test.tsx`)
  - Renders summary from mocked worktree info.
  - Each button fires the correct backend command.
  - Squash reveals textarea with generated message.
  - "Remember" checkbox writes profile via `save_profile`.
  - Backend error keeps modal open with a toast.

### Manual QA scenarios (release-note checklist)

- Create worktree-isolated terminal, do work, close: verify all 4 modal actions.
- Stage a hunk in a 3-hunk file: verify `git diff --staged`.
- Discard a 50-line hunk: confirm bar, both Cancel and Discard paths.
- Rapid-fire stage 5 hunks: toast coalesces, Undo All restores all 5.
- Force stale-hunk error (concurrent Claude write): expected error toast, panel refreshes clean.

**E2E:** not attempted. Per `project_gui_automation` memory, Tauri WebView2 CDP is not viable in this repo. Manual QA bridges the gap.

## Non-goals

- Conflict resolution UI. On any conflict: abort, keep worktree, surface a toast pointing at the fix.
- Session timeline and checkpoints. Separate future spec.
- MCP server management UI. Separate future spec.
- Keyboard shortcuts for hunk navigation and actions. Follow-up if wanted; requires focus management design.
- Retroactive adoption of user-created worktrees into `app_worktrees`. Follow-up.
- Side-by-side diff view. Existing unified view stays.
- User-configurable confirm threshold. `HUNK_CONFIRM_THRESHOLD = 20` is a constant.
- Any rewrite of `FileChangesPanel` or `InlineDiffView`. Additive changes only.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Windows CRLF conversion mangles the patch payload | Medium | Send patch text verbatim without any line-ending normalization. Test with `.gitattributes`-carrying repos in Rust tests. |
| App closes mid-modal, orphan `app_worktrees` row | Low | Startup cleanup removes rows whose paths no longer exist. |
| Concurrent hunk ops on same file from rapid clicks | Low | Frontend serializes per-file invokes with an in-flight lock. Backend git plumbing is process-atomic. |
| Squash message with unusual characters (backticks, unicode) | Low | textarea handles it; `git commit -m` receives the raw string, no shell interpolation. |
| Undo state wiped by React re-render on polling | Medium | Store in Zustand outside the component tree. Polling refresh does not touch store. |
| Merge FF-only conflict UX confusing | Medium | Toast explicitly names the fix ("Rebase your worktree branch onto `<base>` first, then close again"). |
| Migration ordering (new table must exist before commands run) | Low | Migration runs in `Database::new`, called once at startup before any command handler resolves. |

## Success signals

- Zero orphan-worktree reports in telemetry after 30 days of rollout.
- >= 20% of accept actions in a review session happen at the hunk level (vs. all file-level).
- No net-new user reports about "lost my changes" via the reject path.
