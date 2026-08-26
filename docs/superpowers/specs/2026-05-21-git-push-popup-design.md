# Git Push Popup - Design

Date: 2026-05-21
Topic: An IntelliJ-style "Push Commits" modal for the active terminal's git repo, triggered by `Ctrl+Shift+K`.

## Goal

Let users preview the commits they're about to push, change the destination (remote + remote branch) inline, and push (or force-push-with-lease) without dropping to a terminal.

## User flow

1. User presses `Ctrl+Shift+K` (or clicks Push button in File Changes panel header, or "Push to remote…" in the title-bar branch dropdown).
2. Modal opens, loads a single `get_push_preview` for the active terminal's working directory.
3. Modal shows: title (`Push Commits to {repo-name}`), branch route (`local → remote : remote-branch`), commit list, footer (push tags, Push split-button, Cancel).
4. User can edit the remote (dropdown) and the remote-branch name (free-text input).
5. User clicks **Push** → backend runs `git push [-u] [--tags] {remote} HEAD:{remote_branch}`.
   Or opens chevron menu → **Force Push (with lease)** → confirm dialog → `git push --force-with-lease …`.
6. Success: modal closes, git info refreshes for the active terminal, success toast shown.
   Failure: modal stays open, inline error strip above footer + error toast.

## Backend - Rust (`src-tauri/src/commands.rs`)

### New command: `get_push_preview(path) -> PushPreview`

```rust
#[derive(Serialize)]
pub struct PushPreview {
    local_branch: String,
    remotes: Vec<String>,
    default_remote: String,
    default_remote_branch: String,
    has_upstream: bool,
    commits: Vec<PushCommit>,
    ahead: usize,
    behind: usize,
}
#[derive(Serialize)]
pub struct PushCommit {
    sha: String,
    short_sha: String,
    subject: String,
    author: String,
    time_iso: String,
}
```

Implementation:
- `local_branch` via `git rev-parse --abbrev-ref HEAD`. Reject detached HEAD with a clear error.
- `remotes` via `git remote`. If empty → return error `"Repository has no remotes configured"`.
- Upstream lookup: `git rev-parse --abbrev-ref --symbolic-full-name @{u}`. If it succeeds, parse `"{remote}/{branch}"` → `default_remote`, `default_remote_branch`, `has_upstream = true`. If it fails, `has_upstream = false`, `default_remote = "origin"` if present in `remotes` else `remotes[0]`, `default_remote_branch = local_branch`.
- `commits`: when `has_upstream`, `git log {remote}/{branch}..HEAD --format=%H%x1f%h%x1f%s%x1f%an%x1f%aI`. Otherwise, `git log HEAD --not --remotes --format=…` (everything on this branch not already on any remote).
- `ahead = commits.len()`.
- `behind`: when `has_upstream`, `git rev-list --count HEAD..{remote}/{branch}`; else `0`.
- All errors go through existing `wrap_cmd` + `validate_path_is_trusted`.

### Extend `git_push`

Replace the current `git_push(path)` with:

```rust
#[command]
pub async fn git_push(
    state: State<'_, AppState>,
    path: String,
    remote: String,
    remote_branch: String,
    mode: PushMode,        // "normal" | "force_with_lease"
    push_tags: bool,
    set_upstream: bool,    // true when has_upstream was false
) -> Result<(), String>
```

Argument assembly:
```
git push
  [-u                 if set_upstream]
  [--force-with-lease if mode == force_with_lease]
  [--tags             if push_tags]
  <remote>
  HEAD:<remote_branch>
```

Reject `remote` and `remote_branch` containing control chars / leading `-` / spaces / refspec-meaningful chars (`:`, `*`, `?`, `[`, `^`, `~`). `remote` must be a member of the `git remote` list - re-validate server-side, do not trust the frontend.

`PushMode` enum mirrors `AutoStageMode` pattern (`#[serde(rename_all = "snake_case")]`).

Register `get_push_preview` in `main.rs` invoke_handler.

## Frontend - React

### Store (`src/store/appStore.ts`)

Add:
```ts
pushModalOpen: boolean;
pushModalRepoPath: string | null;
openPushModal: (path: string) => void;
closePushModal: () => void;
```

`openPushModal` sets both `pushModalOpen = true` and `pushModalRepoPath = path`. `closePushModal` clears both. Not persisted.

### Component: `src/components/PushModal.tsx`

Renders only when `pushModalOpen && pushModalRepoPath`. Mirrors `WorktreeModal` / `SnippetsModal` shape (motion.div backdrop, escape-to-close, click-outside-to-close).

Internal state:
```ts
preview: PushPreview | null
loading: boolean
error: string | null            // load-error from get_push_preview
pushError: string | null        // push-time error (inline above footer)
remote: string
remoteBranch: string
pushTags: boolean
busy: boolean                   // push in progress
forceConfirmOpen: boolean       // confirm dialog for force-with-lease
```

On open: `invoke<PushPreview>("get_push_preview", { path })`. Seed `remote = preview.default_remote`, `remoteBranch = preview.default_remote_branch`.

Layout:
- **Header** (44px): `Push Commits to {basename(path)}` (left) · `X` close (right).
- **Branch route strip** (40px, accent-tinted bg): `{local-branch}  →  RemoteDropdown  :  RemoteBranchInput`.
- **Body** (flex 1, scrollable):
  - When `loading` → centered spinner.
  - When `error` → error block with retry button.
  - When `preview && !has_upstream` → info pill `New branch - push will set upstream to {remote}/{remote_branch}`.
  - When `preview && behind > 0` → warning pill `Remote has {behind} new commit(s). Pull first to avoid a non-fast-forward.`
  - When `commits.length === 0` → empty-state `No new commits - your branch is up to date.`
  - Otherwise → commit list (one row per commit).
- **Footer** (48px, top border):
  - Left: `☐ Push tags`
  - Right: `[Push ▾]` (split button) + `[Cancel]`
- **Inline push error**: red strip rendered between body and footer when `pushError` is set; close button on the right clears it.

Commit row:
```
<short_sha mono dim>  <subject primary truncate>  <author dim>  <relative-time dim>
```

Split-button (`PushSplitButton` inlined):
- Primary button: `Push` (disabled when `commits.length === 0` or `busy` or empty `remote_branch`).
- Chevron: opens popover with single item `Force Push (with lease)` (disabled when `commits.length === 0` or `busy`).
- Selecting force opens an inline confirm: "Force-push with lease to `{remote}/{remote_branch}`? Refuses if the remote has commits you haven't fetched."
- Busy state: button shows `Pushing…` with a spinner; both the chevron and Cancel are still clickable (Cancel aborts the modal but does NOT cancel the in-flight git push - we let it finish).

Push handler:
```ts
async function runPush(mode: 'normal' | 'force_with_lease') {
  setBusy(true); setPushError(null);
  try {
    await invoke('git_push', {
      path, remote, remoteBranch, mode, pushTags,
      setUpstream: !preview.has_upstream,
    });
    toast.success('Push', `Pushed ${ahead} commit(s) to ${remote}/${remoteBranch}`);
    // Refresh git info for every terminal whose working_directory matches this path,
    // so the title-bar branch widget (ahead/behind dot) updates immediately.
    const { terminals, fetchGitInfo } = useTerminalStore.getState();
    for (const t of terminals.values()) {
      if (t.config.working_directory === path) void fetchGitInfo(t.config.id);
    }
    closePushModal();
  } catch (err) {
    const msg = typeof err === 'string' ? err : 'Push failed';
    setPushError(msg);
    toast.error('Push failed', msg);
  } finally {
    setBusy(false);
  }
}
```

### Keyboard shortcut (`src/hooks/useKeyboardShortcuts.ts`)

Add inside the existing `handleKeyDown`:
```ts
if (ctrl && shift && e.key === 'K') {
  e.preventDefault();
  tryOpenPushModalForActiveTerminal();
}
```

`tryOpenPushModalForActiveTerminal()` (helper exported from appStore or inlined): looks up active terminal → working directory → checks `gitInfoCache.get(activeId)?.is_git_repo`. If yes, `openPushModal(path)`. If not, `toast.info('Push', 'Not in a git repository')`.

### Trigger #2 - File Changes panel header

In `src/components/FileChangesPanel.tsx`, add a `Push` icon button (`Upload` from lucide-react, sky color) next to the existing Commit affordance. Same guard logic - only enabled when in a git repo.

### Trigger #3 - Branch dropdown in title bar

In `src/components/TitleBar.tsx` branch dropdown menu (`branchMenuOpen` panel), add a footer item below the branch list: `Push to remote…` (with `Upload` icon, accent color). Clicking closes the dropdown and opens the push modal.

### Mounting

Add `<AnimatePresence>{pushModalOpen && <PushModal />}</AnimatePresence>` in `App.tsx` alongside other modal mounts.

## Edge cases

- **No remotes configured** → `get_push_preview` returns an error; modal shows it with a one-line message and a Cancel.
- **Detached HEAD** → `get_push_preview` returns an error: "Cannot push from a detached HEAD".
- **No new commits** → modal still opens (lets user see the empty state), Push button disabled (no `Up to date` footer text - the empty-state message in the body is enough).
- **Pushing to a new remote branch** → handled implicitly: `HEAD:{remote_branch}` creates the remote branch. With `set_upstream: true` we also set tracking.
- **Push rejected (non-fast-forward / hook failure / auth)** → backend returns stderr; modal displays it verbatim in the inline error strip. User can edit branch/remote and retry.
- **Concurrent close** during in-flight push → `closePushModal` is allowed; the push completes in the background but its toast still fires.

## Out of scope (explicit YAGNI)

- Per-commit file diff in a right pane
- Plain `--force` (force-with-lease only)
- "All tags vs current branch" tags-mode dropdown
- Remote-branch autocomplete from `git ls-remote`
- Push hooks / pre-push prompts
- Push-with-options (`-o`) configuration
- Reordering / amending commits from this modal
- Multi-repo / "Push from all repos" mode

## Testing notes (informal)

Manual verification matrix:
1. Normal repo with upstream and ≥1 commit ahead → Push succeeds, toast shows N, git info refreshes.
2. Normal repo, branch with no upstream → "New branch" pill shown, default remote-branch = local-branch, push sets upstream.
3. Repo with multiple remotes → dropdown lists all, default = upstream's remote.
4. Repo with no remotes → modal opens with a clean error and a Cancel.
5. Repo with `behind > 0` → warning pill shown, normal push fails non-fast-forward → inline error shown, force-with-lease succeeds (when expected).
6. Detached HEAD → opening modal fails with clear error.
7. Triggers: keyboard, FileChangesPanel button, branch-dropdown entry - all open the modal with the same state.
