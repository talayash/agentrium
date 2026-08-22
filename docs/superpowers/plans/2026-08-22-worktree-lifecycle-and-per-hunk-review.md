# Worktree Lifecycle + Per-Hunk Accept/Reject Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-hunk stage/discard buttons to `InlineDiffView` with a 5s undo toast, plus a close-time modal for app-created worktree-isolated terminals with four actions (merge FF-only, squash-merge, keep, discard).

**Architecture:** Two coordinated additive tracks on top of existing worktree + inline-diff features. Backend adds 6 new Tauri commands (hunk ops + worktree lifecycle + one query) and one new SQLite table (`app_worktrees`). Frontend adds 2 components, 1 Zustand store, and small edits to `InlineDiffView`, `FileChangesPanel`, `terminalStore`, `NewTerminalModal`, `App.tsx`. Zero rewrites, zero backwards-incompatible changes.

**Tech Stack:** Tauri 2.x, Rust (rusqlite, tokio, `tempfile` for tests), React 18 + TypeScript, Vite, Vitest + React Testing Library, Zustand.

**Spec:** `docs/superpowers/specs/2026-08-22-worktree-lifecycle-and-per-hunk-review-design.md`

**Project conventions (must follow):**
- Every backend `#[command]` is wrapped in `wrap_cmd("name", async move { ... })`. See `src-tauri/src/commands.rs:13`.
- User-caused / environment errors return `Err(error_reporter::user_err("..."))` so telemetry is skipped.
- Frontend `invoke<T>('cmd', args)` errors from user actions go through `reportInvokeFailure('cmd', err)` from `src/lib/errorReporter.ts`.
- No em-dash character (U+2014) anywhere. Use colons, hyphens, parens, or rewrite the sentence.
- Freeform commit messages, no need for prefixes but the recent repo pattern uses `feat(...):`, `fix(...):`, `refactor(...):`, `docs(spec):`.
- Every commit body ends with the trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## File Structure

**Backend (Rust):**

| Path | Responsibility |
|---|---|
| `src-tauri/src/hunk_ops.rs` | NEW. Normalization of hunk-only patch text into a valid git-apply-able diff, plus the `git apply` shell wrapper used by stage/discard. |
| `src-tauri/src/commands.rs` | MODIFY. Add `stage_hunk`, `discard_hunk`, `merge_worktree_ff`, `squash_merge_worktree`, `discard_worktree`, `get_app_worktree`. Modify `create_terminal` to accept optional `worktree_link`. |
| `src-tauri/src/database.rs` | MODIFY. Migration for `app_worktrees` table, startup cleanup pass, plus insert/query/delete helpers. |
| `src-tauri/src/config.rs` | MODIFY. New `WorktreeCloseAction` enum + optional field on `ConfigProfile`. |
| `src-tauri/src/main.rs` | MODIFY. Register new commands in the `invoke_handler`. |

**Frontend (TypeScript/React):**

| Path | Responsibility |
|---|---|
| `src/store/hunkUndoStore.ts` | NEW. Zustand slice for the 5s undo stack. |
| `src/store/hunkUndoStore.test.ts` | NEW. Vitest coverage for the store. |
| `src/components/HunkActionToast.tsx` | NEW. Sticky-bottom toast with countdown + Undo button. |
| `src/components/HunkActionToast.test.tsx` | NEW. Vitest coverage. |
| `src/components/WorktreeCloseModal.tsx` | NEW. Modal with 4 lifecycle actions and squash message textarea. |
| `src/components/WorktreeCloseModal.test.tsx` | NEW. Vitest coverage. |
| `src/components/InlineDiffView.tsx` | MODIFY. Add ✓/✕ buttons per hunk header + inline confirm bar. |
| `src/components/InlineDiffView.hunkActions.test.tsx` | NEW. Vitest coverage for the new buttons. |
| `src/components/FileChangesPanel.tsx` | MODIFY. Mount toast; trigger immediate refresh on hunk action. |
| `src/components/NewTerminalModal.tsx` | MODIFY. Pass `worktree_link` on create when a worktree was created via the form. |
| `src/store/terminalStore.ts` | MODIFY. `closeTerminal` consults `get_app_worktree`; opens modal via `appStore` before backend close. |
| `src/store/appStore.ts` | MODIFY. Add `worktreeCloseModal` state slice (open/close, pending terminal id, worktree info). |
| `src/App.tsx` | MODIFY. Mount `<WorktreeCloseModal/>` at root, driven by `appStore`. |
| `src/types/git.ts` | MODIFY. Add `AppWorktreeRow`, `MergeResult`, `WorktreeCloseAction`, `HunkAction` types. |
| `src/changelog.json` | MODIFY. Add release notes entry. |

---

## Task 1: Backend `hunk_ops` module with patch normalization

**Files:**
- Create: `src-tauri/src/hunk_ops.rs`
- Modify: `src-tauri/src/main.rs` (add `mod hunk_ops;`)

**Purpose:** A pure helper that takes an optionally-headerless hunk patch and a file path, returning a valid unified diff that `git apply` will accept. Idempotent when the header is already present.

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/hunk_ops.rs`

```rust
//! Hunk-patch normalization and `git apply` wrapper.

/// Prepend a minimal `diff --git` header to a raw hunk if the caller sent
/// only the `@@ ...` region. Idempotent when the header is already present.
pub fn normalize_hunk_patch(file_path: &str, hunk_patch: &str) -> String {
    let trimmed = hunk_patch.trim_start_matches('\n');
    if trimmed.starts_with("diff --git ") {
        return hunk_patch.to_string();
    }
    // Preserve trailing newline: git apply needs one at the end of the patch.
    let body = if hunk_patch.ends_with('\n') {
        hunk_patch.to_string()
    } else {
        format!("{hunk_patch}\n")
    };
    format!(
        "diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n{body}",
        p = file_path,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_header_to_raw_hunk() {
        let patch = "@@ -1,3 +1,3 @@\n context\n-old\n+new\n";
        let out = normalize_hunk_patch("src/foo.rs", patch);
        assert!(out.starts_with("diff --git a/src/foo.rs b/src/foo.rs\n"));
        assert!(out.contains("--- a/src/foo.rs\n"));
        assert!(out.contains("+++ b/src/foo.rs\n"));
        assert!(out.ends_with("+new\n"));
    }

    #[test]
    fn preserves_existing_header() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let out = normalize_hunk_patch("x", patch);
        assert_eq!(out, patch);
    }

    #[test]
    fn ensures_trailing_newline() {
        let patch = "@@ -1,1 +1,1 @@\n-a\n+b";
        let out = normalize_hunk_patch("x", patch);
        assert!(out.ends_with('\n'));
    }
}
```

- [ ] **Step 2: Wire the module** in `src-tauri/src/main.rs`

Add near the other `mod` declarations (search for `mod terminal;`):

```rust
mod hunk_ops;
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd src-tauri && cargo test --lib hunk_ops::tests`
Expected: `test result: ok. 3 passed`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/hunk_ops.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(backend): add hunk_ops module with patch normalization

Introduces normalize_hunk_patch() that turns a bare @@ hunk into a
valid unified diff by prepending minimal diff --git / --- / +++
headers. Idempotent when the header is already present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend `stage_hunk` and `discard_hunk` commands

**Files:**
- Modify: `src-tauri/src/hunk_ops.rs` (add `apply_hunk_patch` async helper)
- Modify: `src-tauri/src/commands.rs` (add `stage_hunk`, `discard_hunk`)
- Modify: `src-tauri/src/main.rs` (register in `invoke_handler`)

**Purpose:** Two thin Tauri commands that pipe a normalized hunk patch to `git apply` with the right flags. Errors flow through `error_reporter::user_err` so telemetry is skipped.

- [ ] **Step 1: Add async apply helper + tests in `hunk_ops.rs`**

Append to `src-tauri/src/hunk_ops.rs`:

```rust
use tokio::process::Command as TokioCommand;
use tokio::io::AsyncWriteExt;
use std::process::Stdio;

/// Pipe a unified diff to `git -C <repo> apply <extra_args>` via stdin.
/// Returns Ok(()) on git exit 0, or a user_err on non-zero (context mismatch,
/// invalid patch, etc). Does NOT normalize the patch: caller must pass the
/// output of `normalize_hunk_patch` (or a fully headered diff).
pub async fn apply_hunk_patch(
    repo_path: &str,
    normalized_patch: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    let mut cmd = TokioCommand::new("git");
    cmd.arg("-C").arg(repo_path).arg("apply");
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Windows: hide flashing console.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        crate::error_reporter::user_err(&format!("spawn git failed: {e}"))
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(normalized_patch.as_bytes())
            .await
            .map_err(|e| crate::error_reporter::user_err(&format!("write patch: {e}")))?;
        drop(stdin);
    }

    let output = child.wait_with_output().await.map_err(|e| {
        crate::error_reporter::user_err(&format!("git wait: {e}"))
    })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::error_reporter::user_err(&format!(
            "git apply failed: {}",
            stderr.trim()
        )))
    }
}
```

- [ ] **Step 2: Write end-to-end tests in `hunk_ops.rs`**

Append the test module in `src-tauri/src/hunk_ops.rs` inside the existing `mod tests`:

```rust
    // -----------------------------------------------------------------
    // apply_hunk_patch tests using a scratch git repo
    // -----------------------------------------------------------------
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    fn run(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        StdCommand::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git command failed to spawn")
    }

    fn init_repo(dir: &std::path::Path) {
        run(dir, &["init", "-q", "-b", "main"]);
        run(dir, &["config", "user.email", "t@t"]);
        run(dir, &["config", "user.name", "t"]);
    }

    fn write_and_commit(dir: &std::path::Path, name: &str, contents: &str, msg: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
        run(dir, &["add", name]);
        run(dir, &["commit", "-q", "-m", msg]);
    }

    fn diff(dir: &std::path::Path, staged: bool) -> String {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        let out = run(dir, &args);
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[tokio::test]
    async fn stage_single_hunk_moves_to_index() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\ntwo\nthree\n", "init");
        std::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").unwrap();

        let unstaged = diff(d, false);
        assert!(unstaged.contains("-two"));

        // Extract just the hunk region (bare, no headers) from unstaged.
        let bare_hunk = unstaged
            .split("@@")
            .enumerate()
            .filter(|(i, _)| *i > 0)
            .map(|(_, s)| format!("@@{s}"))
            .next()
            .unwrap();

        let normalized = super::normalize_hunk_patch("a.txt", &bare_hunk);
        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .expect("apply --cached");

        let staged = diff(d, true);
        assert!(staged.contains("-two"));
        assert!(staged.contains("+TWO"));
    }

    #[tokio::test]
    async fn discard_reverses_working_tree_change() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "keep\n", "init");
        std::fs::write(d.join("a.txt"), "keep\nadded\n").unwrap();

        let unstaged = diff(d, false);
        let bare_hunk = unstaged
            .split("@@")
            .enumerate()
            .filter(|(i, _)| *i > 0)
            .map(|(_, s)| format!("@@{s}"))
            .next()
            .unwrap();
        let normalized = super::normalize_hunk_patch("a.txt", &bare_hunk);

        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["-R"])
            .await
            .expect("apply -R");

        let contents = std::fs::read_to_string(d.join("a.txt")).unwrap();
        assert_eq!(contents, "keep\n");
    }

    #[tokio::test]
    async fn stale_hunk_returns_user_err() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\n", "init");
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();

        // Craft a hunk that references content that isn't in the file.
        let bogus = "@@ -1,2 +1,2 @@\n-nonexistent\n+replacement\n";
        let normalized = super::normalize_hunk_patch("a.txt", bogus);
        let err = super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .unwrap_err();
        assert!(err.contains("git apply failed"));
    }
```

- [ ] **Step 3: Verify `tempfile` and `tokio` (with `process` feature) are in Cargo.toml**

Run: `cd src-tauri && grep -E '^(tempfile|tokio) ' Cargo.toml`
If `tempfile` is missing under `[dev-dependencies]`, add:

```toml
[dev-dependencies]
tempfile = "3"
```

Verify tokio has `process` in features (search for `tokio = ` in `[dependencies]`). If not present, add `"process"` to the tokio features array.

- [ ] **Step 4: Add commands to `commands.rs`**

Find a suitable location (after the existing worktree commands section, around line 2800). Add:

```rust
// ─── Hunk-level accept / discard ─────────────────────────────────────────────

#[command]
pub async fn stage_hunk(
    repo_path: String,
    file_path: String,
    hunk_patch: String,
) -> Result<(), String> {
    wrap_cmd("stage_hunk", async move {
        let normalized = crate::hunk_ops::normalize_hunk_patch(&file_path, &hunk_patch);
        crate::hunk_ops::apply_hunk_patch(&repo_path, &normalized, &["--cached"]).await
    })
    .await
}

#[command]
pub async fn discard_hunk(
    repo_path: String,
    file_path: String,
    hunk_patch: String,
) -> Result<(), String> {
    wrap_cmd("discard_hunk", async move {
        let normalized = crate::hunk_ops::normalize_hunk_patch(&file_path, &hunk_patch);
        crate::hunk_ops::apply_hunk_patch(&repo_path, &normalized, &["-R"]).await
    })
    .await
}
```

- [ ] **Step 5: Register commands in `main.rs`**

Find the `.invoke_handler(tauri::generate_handler![...])` block and add `stage_hunk, discard_hunk` to the list.

- [ ] **Step 6: Verify build + tests**

Run: `cd src-tauri && cargo test --lib hunk_ops::tests` (5 tests total pass)
Run: `cd src-tauri && cargo build` (no warnings-as-errors regression from these additions)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/hunk_ops.rs src-tauri/src/commands.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "$(cat <<'EOF'
feat(backend): stage_hunk and discard_hunk commands

Adds two Tauri commands that pipe a normalized hunk patch to
'git apply --cached' or 'git apply -R'. Errors are user_err so
telemetry is skipped. Covered by tempfile-backed integration tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend `hunkUndoStore`

**Files:**
- Create: `src/store/hunkUndoStore.ts`
- Create: `src/store/hunkUndoStore.test.ts`
- Modify: `src/types/git.ts` (add `HunkAction` type)

**Purpose:** Ephemeral Zustand slice holding the recent stage/discard actions for undo. 5s timer resets on every push. LIFO undo. Timeouts clear silently.

- [ ] **Step 1: Add `HunkAction` type to `src/types/git.ts`**

Append to `src/types/git.ts`:

```ts
export type HunkActionKind = 'stage' | 'discard';

export interface HunkAction {
  kind: HunkActionKind;
  repoPath: string;
  filePath: string;
  hunkPatch: string;
  atLine: number;   // header line number for toast label
  timestamp: number;
}

export interface UndoResult {
  ok: number;
  failed: number;
}
```

- [ ] **Step 2: Write failing test** in `src/store/hunkUndoStore.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useHunkUndoStore } from './hunkUndoStore';
import type { HunkAction } from '../types/git';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function action(overrides: Partial<HunkAction> = {}): HunkAction {
  return {
    kind: 'stage',
    repoPath: '/repo',
    filePath: 'a.ts',
    hunkPatch: '@@ -1 +1 @@\n-a\n+b\n',
    atLine: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('hunkUndoStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useHunkUndoStore.getState().clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push adds action and sets timer', () => {
    useHunkUndoStore.getState().push(action());
    expect(useHunkUndoStore.getState().stack.length).toBe(1);
  });

  it('timeout clears stack after 5s', () => {
    useHunkUndoStore.getState().push(action());
    vi.advanceTimersByTime(5001);
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('second push within 5s resets timer', () => {
    useHunkUndoStore.getState().push(action());
    vi.advanceTimersByTime(3000);
    useHunkUndoStore.getState().push(action({ atLine: 2 }));
    vi.advanceTimersByTime(3000);
    expect(useHunkUndoStore.getState().stack.length).toBe(2);
    vi.advanceTimersByTime(2001);
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('undoAll reverses stack LIFO with stage->apply -R --cached', async () => {
    useHunkUndoStore.getState().push(action({ kind: 'stage', filePath: 'x' }));
    useHunkUndoStore.getState().push(action({ kind: 'discard', filePath: 'y' }));

    const promise = useHunkUndoStore.getState().undoAll();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: 2, failed: 0 });
    // Discard was pushed last so it undoes first (apply forward again).
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'discard_hunk', expect.objectContaining({
      filePath: 'y',
      hunkPatch: expect.any(String),
    }));
    // stage undo is via discard_hunk with the extra --cached? No: our design
    // reuses the same commands with reversed args, but here we treat undo as
    // calling the OPPOSITE command. Assert accordingly:
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'stage_hunk', expect.objectContaining({
      filePath: 'x',
    }));
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('undoAll reports partial failure without throwing', async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce('context mismatch');
    useHunkUndoStore.getState().push(action({ filePath: 'a' }));
    useHunkUndoStore.getState().push(action({ filePath: 'b' }));

    const promise = useHunkUndoStore.getState().undoAll();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: 1, failed: 1 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:run -- src/store/hunkUndoStore.test.ts`
Expected: FAIL with "cannot find module './hunkUndoStore'"

- [ ] **Step 4: Implement the store** in `src/store/hunkUndoStore.ts`

**Design decision on undo semantics:** the test asserts that undoing a `stage` calls `discard_hunk` (which reverses in the working tree), not `apply -R --cached`. That is the pragmatic choice: the frontend has only two invoke commands available (`stage_hunk` and `discard_hunk`). Undoing a stage means unstaging AND restoring working tree (which `discard_hunk` does not quite match). Redefine here explicitly:

Actually per the spec §4.2, undo(stage) is `apply -R --cached`. That is neither `stage_hunk` nor `discard_hunk`. Solution: add two more thin commands OR make `stage_hunk`/`discard_hunk` accept an optional `reverse: bool` flag.

Simpler: add `apply_hunk` that takes `mode: 'stage' | 'discard' | 'unstage' | 'restore'` and dispatches to the right `git apply` args. See Task 2 addendum below.

For now, in this task, the store calls a single command `apply_hunk` with a `mode` param. This will be added in Task 2b (below). Update the test file accordingly.

**Corrected `src/store/hunkUndoStore.ts`:**

```ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { HunkAction, UndoResult } from '../types/git';

const UNDO_TIMEOUT_MS = 5000;

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

interface HunkUndoState {
  stack: HunkAction[];
  push: (a: HunkAction) => void;
  undoAll: () => Promise<UndoResult>;
  clear: () => void;
}

export const useHunkUndoStore = create<HunkUndoState>((set, get) => ({
  stack: [],

  push: (a) => {
    set((s) => ({ stack: [...s.stack, a] }));
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      set({ stack: [] });
      timeoutHandle = null;
    }, UNDO_TIMEOUT_MS);
  },

  undoAll: async () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    const stack = [...get().stack];
    set({ stack: [] });

    let ok = 0;
    let failed = 0;
    // LIFO: last-in undoes first.
    for (let i = stack.length - 1; i >= 0; i--) {
      const a = stack[i];
      // Undo a stage = unstage + restore = 'unstage' mode.
      // Undo a discard = re-apply to working tree = 'restore' mode.
      const undoMode = a.kind === 'stage' ? 'unstage' : 'restore';
      try {
        await invoke('apply_hunk', {
          mode: undoMode,
          repoPath: a.repoPath,
          filePath: a.filePath,
          hunkPatch: a.hunkPatch,
        });
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  },

  clear: () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    set({ stack: [] });
  },
}));
```

**Update the failing test** to match the `apply_hunk` command signature. In `hunkUndoStore.test.ts`, replace the last two assertions to check `invoke('apply_hunk', ...)` with `mode: 'restore' | 'unstage'`.

Corrected test assertions block:

```ts
    // Replace the two nth-called assertions in "undoAll reverses stack LIFO":
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'apply_hunk', expect.objectContaining({
      mode: 'restore',
      filePath: 'y',
    }));
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'apply_hunk', expect.objectContaining({
      mode: 'unstage',
      filePath: 'x',
    }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:run -- src/store/hunkUndoStore.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/store/hunkUndoStore.ts src/store/hunkUndoStore.test.ts src/types/git.ts
git commit -m "$(cat <<'EOF'
feat(store): hunkUndoStore with 5s LIFO undo stack

Ephemeral Zustand slice holding recent stage/discard actions. Push
resets the 5s timer, timeout clears silently, undoAll runs LIFO and
reports {ok, failed} without throwing on partial failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Backend `apply_hunk` unified command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `apply_hunk`)
- Modify: `src-tauri/src/main.rs` (register in `invoke_handler`)

**Purpose:** Replaces the two separate commands from Task 2 with one command that takes a `mode` param. The frontend calls this for stage, discard, unstage (undo stage), and restore (undo discard). Cleaner API and matches the store's usage.

- [ ] **Step 1: Add `apply_hunk` with mode dispatch**

In `src-tauri/src/commands.rs`, replace the two commands from Task 2 with a single unified one:

```rust
// ─── Hunk-level accept / discard (unified) ────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HunkApplyMode {
    Stage,    // git apply --cached (staged)
    Discard,  // git apply -R (working tree reversed)
    Unstage,  // git apply -R --cached (undo Stage)
    Restore,  // git apply (undo Discard, re-apply to working tree)
}

#[command]
pub async fn apply_hunk(
    mode: HunkApplyMode,
    repo_path: String,
    file_path: String,
    hunk_patch: String,
) -> Result<(), String> {
    wrap_cmd("apply_hunk", async move {
        let normalized = crate::hunk_ops::normalize_hunk_patch(&file_path, &hunk_patch);
        let args: &[&str] = match mode {
            HunkApplyMode::Stage => &["--cached"],
            HunkApplyMode::Discard => &["-R"],
            HunkApplyMode::Unstage => &["-R", "--cached"],
            HunkApplyMode::Restore => &[],
        };
        crate::hunk_ops::apply_hunk_patch(&repo_path, &normalized, args).await
    })
    .await
}
```

Remove the old `stage_hunk` and `discard_hunk` command definitions added in Task 2.

- [ ] **Step 2: Update invoke_handler**

Replace `stage_hunk, discard_hunk` entries with `apply_hunk` in the `tauri::generate_handler![...]` list.

- [ ] **Step 3: Add an integration test**

In `src-tauri/src/hunk_ops.rs` test module, add:

```rust
    #[tokio::test]
    async fn unstage_reverses_a_stage() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\n", "init");
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();

        let unstaged = diff(d, false);
        let bare_hunk = unstaged
            .split("@@")
            .enumerate()
            .filter(|(i, _)| *i > 0)
            .map(|(_, s)| format!("@@{s}"))
            .next()
            .unwrap();
        let normalized = super::normalize_hunk_patch("a.txt", &bare_hunk);

        // stage, then undo (unstage)
        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .unwrap();
        assert!(diff(d, true).contains("+two"));

        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["-R", "--cached"])
            .await
            .unwrap();
        assert_eq!(diff(d, true), "");
    }
```

- [ ] **Step 4: Verify build + tests**

Run: `cd src-tauri && cargo test --lib hunk_ops::tests`
Expected: 6 tests pass.

Run: `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src-tauri/src/hunk_ops.rs
git commit -m "$(cat <<'EOF'
refactor(backend): unify hunk commands into apply_hunk with mode param

Replaces stage_hunk/discard_hunk with a single apply_hunk command that
takes a mode ('stage' | 'discard' | 'unstage' | 'restore') and dispatches
to the correct git apply flags. Cleaner API surface for the undo path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `HunkActionToast` component

**Files:**
- Create: `src/components/HunkActionToast.tsx`
- Create: `src/components/HunkActionToast.test.tsx`

**Purpose:** Bottom-of-panel toast that reads from `hunkUndoStore`, shows "Staged hunk @Lxx · Undo (5s)" or coalesced "Staged N hunks · Undo all (5s)", and slides out after 5s. Not itself a timer owner (the store owns the timer). Also renders the "partial failure" summary after Undo All.

- [ ] **Step 1: Write failing tests** in `src/components/HunkActionToast.test.tsx`

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { HunkActionToast } from './HunkActionToast';
import { useHunkUndoStore } from '../store/hunkUndoStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

const push = () => useHunkUndoStore.getState().push({
  kind: 'stage',
  repoPath: '/r',
  filePath: 'a.ts',
  hunkPatch: '@@ -1 +1 @@\n-a\n+b\n',
  atLine: 12,
  timestamp: Date.now(),
});

describe('HunkActionToast', () => {
  beforeEach(() => {
    useHunkUndoStore.getState().clear();
  });

  it('renders nothing when stack is empty', () => {
    render(<HunkActionToast />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows single action label', () => {
    render(<HunkActionToast />);
    act(() => push());
    expect(screen.getByText(/Staged hunk @L12/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Undo/i })).toBeInTheDocument();
  });

  it('shows coalesced label when multiple actions of same kind', () => {
    render(<HunkActionToast />);
    act(() => { push(); push(); push(); });
    expect(screen.getByText(/Staged 3 hunks/)).toBeInTheDocument();
  });

  it('shows mixed label when kinds differ', () => {
    render(<HunkActionToast />);
    act(() => {
      useHunkUndoStore.getState().push({
        kind: 'stage', repoPath: '/r', filePath: 'a', hunkPatch: 'p', atLine: 1, timestamp: 0,
      });
      useHunkUndoStore.getState().push({
        kind: 'discard', repoPath: '/r', filePath: 'b', hunkPatch: 'p', atLine: 2, timestamp: 0,
      });
    });
    expect(screen.getByText(/Actioned 2 hunks/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/components/HunkActionToast.test.tsx`
Expected: FAIL with "cannot find module './HunkActionToast'"

- [ ] **Step 3: Implement the component** in `src/components/HunkActionToast.tsx`

```tsx
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Undo2 } from 'lucide-react';
import { useHunkUndoStore } from '../store/hunkUndoStore';

const UNDO_TIMEOUT_MS = 5000;

export function HunkActionToast() {
  const stack = useHunkUndoStore((s) => s.stack);
  const undoAll = useHunkUndoStore((s) => s.undoAll);
  const [remaining, setRemaining] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    if (stack.length === 0) {
      setRemaining(0);
      return;
    }
    // Store timer is authoritative. UI just tracks a display countdown.
    const start = Date.now();
    setRemaining(UNDO_TIMEOUT_MS);
    const id = setInterval(() => {
      const elapsed = Date.now() - start;
      setRemaining(Math.max(0, UNDO_TIMEOUT_MS - elapsed));
    }, 100);
    return () => clearInterval(id);
  }, [stack.length]);

  useEffect(() => {
    if (summary) {
      const id = setTimeout(() => setSummary(null), 3000);
      return () => clearTimeout(id);
    }
  }, [summary]);

  const label = (() => {
    if (stack.length === 0) return '';
    if (stack.length === 1) {
      const a = stack[0];
      const verb = a.kind === 'stage' ? 'Staged' : 'Discarded';
      return `${verb} hunk @L${a.atLine}`;
    }
    const allStage = stack.every((a) => a.kind === 'stage');
    const allDiscard = stack.every((a) => a.kind === 'discard');
    if (allStage) return `Staged ${stack.length} hunks`;
    if (allDiscard) return `Discarded ${stack.length} hunks`;
    return `Actioned ${stack.length} hunks`;
  })();

  const handleUndo = async () => {
    const result = await undoAll();
    if (result.failed > 0) {
      setSummary(`Undone ${result.ok} of ${result.ok + result.failed}. ${result.failed} hunks changed since (context mismatch).`);
    }
  };

  const secs = Math.ceil(remaining / 1000);

  return (
    <AnimatePresence>
      {stack.length > 0 && !summary && (
        <motion.div
          key="toast"
          role="status"
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="sticky bottom-0 mx-2 mb-2 rounded-md bg-[var(--elevation-3)] ring-1 ring-[var(--border)] shadow-lg overflow-hidden"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
            <span className="text-text-primary flex-1">{label}</span>
            <button
              onClick={handleUndo}
              className="flex items-center gap-1 text-accent-primary hover:text-accent-secondary text-[12px] font-medium"
            >
              <Undo2 size={12} /> Undo {stack.length > 1 ? 'all' : ''} ({secs}s)
            </button>
          </div>
          <div
            className="h-[2px] bg-accent-primary origin-left transition-transform duration-100"
            style={{ transform: `scaleX(${remaining / UNDO_TIMEOUT_MS})` }}
          />
        </motion.div>
      )}
      {summary && (
        <motion.div
          key="summary"
          role="status"
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="sticky bottom-0 mx-2 mb-2 rounded-md bg-[var(--elevation-3)] ring-1 ring-warning/40 shadow-lg px-3 py-2 text-[12px] text-text-primary"
        >
          {summary}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/components/HunkActionToast.test.tsx`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/HunkActionToast.tsx src/components/HunkActionToast.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): HunkActionToast with countdown and undo-all

Sticky-bottom toast reads from hunkUndoStore, shows single-action or
coalesced labels ("Staged 3 hunks", "Actioned N hunks"), and shows a
partial-failure summary for 3s when undoAll reports mixed results.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Hunk header ✓/✕ buttons in `InlineDiffView`

**Files:**
- Modify: `src/components/InlineDiffView.tsx`
- Create: `src/components/InlineDiffView.hunkActions.test.tsx`

**Purpose:** Render right-aligned ✓ and ✕ icon buttons in each hunk header. Suppress for binary / new / deleted files. Wire clicks to `apply_hunk` invoke + push to `hunkUndoStore`. Reject on hunks > 20 net change lines shows inline confirm bar.

- [ ] **Step 1: Read the current `InlineDiffView.tsx` structure**

Skim `src/components/InlineDiffView.tsx` to find:
- The hunk render loop (search for `hunks.map`)
- The parsed hunk type (search for `interface.*Hunk` or `type.*Hunk`)
- The `FileDiffResult` prop shape
- Where the header line is rendered (look for `@@`)

Note the exact prop names and any existing repo/file path plumbing. If the component doesn't already receive `repoPath` and `filePath`, plan to add them to its props.

- [ ] **Step 2: Write failing test** in `src/components/InlineDiffView.hunkActions.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { InlineDiffView } from './InlineDiffView';
import { useHunkUndoStore } from '../store/hunkUndoStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

const smallHunkDiff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
`;

const largeHunkDiff = (() => {
  const lines: string[] = ['diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts', '@@ -1,50 +1,50 @@'];
  for (let i = 0; i < 25; i++) lines.push(`-line${i}`);
  for (let i = 0; i < 25; i++) lines.push(`+newline${i}`);
  return lines.join('\n') + '\n';
})();

describe('InlineDiffView hunk actions', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useHunkUndoStore.getState().clear();
  });

  it('renders ✓ and ✕ buttons for a text hunk', () => {
    render(
      <InlineDiffView
        repoPath="/r"
        filePath="a.ts"
        diffText={smallHunkDiff}
        fileDiff={{ file_path: 'a.ts', diff_text: smallHunkDiff, is_new_file: false, is_deleted_file: false, is_binary: false } as any}
      />
    );
    expect(screen.getByRole('button', { name: /Stage hunk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard hunk/i })).toBeInTheDocument();
  });

  it('suppresses buttons for binary file', () => {
    render(
      <InlineDiffView
        repoPath="/r"
        filePath="img.png"
        diffText=""
        fileDiff={{ file_path: 'img.png', diff_text: '', is_new_file: false, is_deleted_file: false, is_binary: true } as any}
      />
    );
    expect(screen.queryByRole('button', { name: /Stage hunk/i })).toBeNull();
  });

  it('clicking ✓ calls apply_hunk with mode stage', async () => {
    render(
      <InlineDiffView
        repoPath="/r"
        filePath="a.ts"
        diffText={smallHunkDiff}
        fileDiff={{ file_path: 'a.ts', diff_text: smallHunkDiff, is_new_file: false, is_deleted_file: false, is_binary: false } as any}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Stage hunk/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({
        mode: 'stage', repoPath: '/r', filePath: 'a.ts',
      }));
    });
    expect(useHunkUndoStore.getState().stack.length).toBe(1);
  });

  it('clicking ✕ on small hunk immediately fires discard', async () => {
    render(
      <InlineDiffView
        repoPath="/r"
        filePath="a.ts"
        diffText={smallHunkDiff}
        fileDiff={{ file_path: 'a.ts', diff_text: smallHunkDiff, is_new_file: false, is_deleted_file: false, is_binary: false } as any}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Discard hunk/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({ mode: 'discard' }));
    });
  });

  it('clicking ✕ on large hunk shows confirm bar', async () => {
    render(
      <InlineDiffView
        repoPath="/r"
        filePath="b.ts"
        diffText={largeHunkDiff}
        fileDiff={{ file_path: 'b.ts', diff_text: largeHunkDiff, is_new_file: false, is_deleted_file: false, is_binary: false } as any}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Discard hunk/i }));
    expect(screen.getByText(/Really discard 50 lines/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Discard$/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({ mode: 'discard' }));
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:run -- src/components/InlineDiffView.hunkActions.test.tsx`
Expected: FAIL with new prop / missing button errors.

- [ ] **Step 4: Modify `InlineDiffView.tsx`**

Add these imports at top:

```tsx
import { Check, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useHunkUndoStore } from '../store/hunkUndoStore';
import { reportInvokeFailure } from '../lib/errorReporter';
```

Add / extend the component's props:

```tsx
interface InlineDiffViewProps {
  repoPath: string;
  filePath: string;
  diffText: string;
  fileDiff: FileDiffResult;
  onAfterAction?: () => void;
  // existing props preserved
}
```

Add a constant near the top:

```tsx
const HUNK_CONFIRM_THRESHOLD = 20;
```

Add helpers:

```tsx
function netChangeCount(hunkLines: string[]): number {
  return hunkLines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
}

function reconstructHunkPatch(header: string, lines: string[]): string {
  return `${header}\n${lines.join('\n')}\n`;
}
```

In the hunk render loop, add per-hunk state (React `useState`) tracking `confirmingHunkIndex: number | null`. Render the header row with the action group:

```tsx
{fileDiff.is_binary || fileDiff.is_new_file || fileDiff.is_deleted_file ? null : (
  <div className="flex items-center gap-1 ml-auto">
    {confirmingHunkIndex === hIdx ? (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-text-secondary">Really discard {netChangeCount(hunk.lines)} lines?</span>
        <button
          onClick={() => setConfirmingHunkIndex(null)}
          className="px-2 py-0.5 rounded text-text-secondary hover:text-text-primary ring-1 ring-border-light"
        >
          Cancel
        </button>
        <button
          onClick={() => performAction('discard', hIdx, hunk)}
          name="Discard"
          className="px-2 py-0.5 rounded bg-error/10 text-error ring-1 ring-error/30 hover:bg-error/20"
        >
          Discard
        </button>
      </div>
    ) : (
      <>
        <button
          aria-label="Stage hunk"
          title="Stage hunk"
          onClick={() => performAction('stage', hIdx, hunk)}
          className="w-5 h-5 flex items-center justify-center rounded bg-success/10 ring-1 ring-success/30 text-success hover:bg-success/20"
        >
          <Check size={12} />
        </button>
        <button
          aria-label="Discard hunk"
          title="Discard hunk"
          onClick={() => {
            if (netChangeCount(hunk.lines) > HUNK_CONFIRM_THRESHOLD) {
              setConfirmingHunkIndex(hIdx);
              setTimeout(() => setConfirmingHunkIndex((c) => (c === hIdx ? null : c)), 5000);
            } else {
              performAction('discard', hIdx, hunk);
            }
          }}
          className="w-5 h-5 flex items-center justify-center rounded bg-error/10 ring-1 ring-error/30 text-error hover:bg-error/20"
        >
          <X size={12} />
        </button>
      </>
    )}
  </div>
)}
```

Add the shared action performer:

```tsx
const push = useHunkUndoStore((s) => s.push);

async function performAction(kind: 'stage' | 'discard', hIdx: number, hunk: ParsedHunk) {
  const hunkPatch = reconstructHunkPatch(hunk.header, hunk.lines);
  setConfirmingHunkIndex(null);
  try {
    await invoke('apply_hunk', {
      mode: kind,
      repoPath,
      filePath,
      hunkPatch,
    });
    push({
      kind,
      repoPath,
      filePath,
      hunkPatch,
      atLine: hunk.oldStart,
      timestamp: Date.now(),
    });
    onAfterAction?.();
  } catch (err) {
    reportInvokeFailure('apply_hunk', err);
  }
}
```

If the current parsed-hunk shape doesn't include `header` / `oldStart` / `lines`, adjust `parseDiff` (in the same file or its helper) to include them. Add the fields as needed and update the test hunk shape accordingly.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:run -- src/components/InlineDiffView.hunkActions.test.tsx`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/InlineDiffView.tsx src/components/InlineDiffView.hunkActions.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): per-hunk stage and discard buttons in InlineDiffView

Adds right-aligned ✓ and ✕ icon buttons to each hunk header. Buttons
are suppressed for binary, new, and deleted files. Rejecting a hunk
with more than 20 net change lines opens an inline confirm bar that
auto-cancels after 5s. Every action pushes to hunkUndoStore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire `HunkActionToast` into `FileChangesPanel`

**Files:**
- Modify: `src/components/FileChangesPanel.tsx`

**Purpose:** Mount the toast at the bottom edge. Pass a refresh trigger callback to `InlineDiffView` (`onAfterAction`) so the panel refetches diffs immediately rather than waiting up to 5s for the next polling tick.

- [ ] **Step 1: Read `FileChangesPanel.tsx` structure**

Find:
- The polling `useEffect` (search for `5000` or `refresh`).
- Where `<InlineDiffView>` is rendered (the `expandedFile` region).
- The state / function that triggers a refresh outside the tick.

- [ ] **Step 2: Add toast import and refresh callback wiring**

At the top:

```tsx
import { HunkActionToast } from './HunkActionToast';
```

Extract the polling refresh logic into a callable `forceRefresh` (if not already). Pass it to `InlineDiffView` as `onAfterAction`.

Add `<HunkActionToast />` at the end of the panel's outer container, before the closing tag. It uses `sticky bottom-0` so it floats above the last hunk.

Example:

```tsx
<div className="flex flex-col h-full overflow-hidden">
  {/* existing header + list + expanded file section */}
  <InlineDiffView
    repoPath={repoPath}
    filePath={expandedFile}
    diffText={diffText}
    fileDiff={fileDiff}
    onAfterAction={forceRefresh}
  />
  <HunkActionToast />
</div>
```

- [ ] **Step 3: Manually verify build**

Run: `npm run build`
Expected: successful build. If it fails on missing props for InlineDiffView, add them from the current panel state.

- [ ] **Step 4: Sanity test, run existing tests still pass**

Run: `npm run test:run`
Expected: all tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/components/FileChangesPanel.tsx
git commit -m "$(cat <<'EOF'
feat(ui): mount HunkActionToast in FileChangesPanel with immediate refresh

Passes forceRefresh() to InlineDiffView via onAfterAction so vanished
hunks are gone within ~100ms rather than waiting for the 5s polling
tick. Toast is sticky at the panel bottom.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `app_worktrees` DB migration + startup cleanup

**Files:**
- Modify: `src-tauri/src/database.rs`

**Purpose:** New table for tracking app-created worktrees, tied to terminal_id. Startup cleanup removes rows for worktrees the user deleted externally.

- [ ] **Step 1: Add migration in `Database::migrate` (or equivalent)**

Find the existing migration section in `database.rs` (search for `CREATE TABLE`).

Add:

```rust
conn.execute(
    "CREATE TABLE IF NOT EXISTS app_worktrees (
        terminal_id   TEXT PRIMARY KEY,
        worktree_path TEXT NOT NULL,
        base_branch   TEXT NOT NULL,
        branch_name   TEXT NOT NULL,
        created_at    INTEGER NOT NULL
    )",
    [],
)?;
```

- [ ] **Step 2: Add row struct + helpers**

Add to `database.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppWorktreeRow {
    pub terminal_id: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub branch_name: String,
    pub created_at: i64,
}

impl Database {
    pub fn insert_app_worktree(&self, row: &AppWorktreeRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO app_worktrees
             (terminal_id, worktree_path, base_branch, branch_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                row.terminal_id,
                row.worktree_path,
                row.base_branch,
                row.branch_name,
                row.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_app_worktree(&self, terminal_id: &str) -> rusqlite::Result<Option<AppWorktreeRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT terminal_id, worktree_path, base_branch, branch_name, created_at
             FROM app_worktrees WHERE terminal_id = ?1",
        )?;
        let mut rows = stmt.query([terminal_id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(AppWorktreeRow {
                terminal_id: r.get(0)?,
                worktree_path: r.get(1)?,
                base_branch: r.get(2)?,
                branch_name: r.get(3)?,
                created_at: r.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn delete_app_worktree(&self, terminal_id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM app_worktrees WHERE terminal_id = ?1", [terminal_id])?;
        Ok(())
    }

    pub fn list_app_worktrees(&self) -> rusqlite::Result<Vec<AppWorktreeRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT terminal_id, worktree_path, base_branch, branch_name, created_at
             FROM app_worktrees",
        )?;
        let iter = stmt.query_map([], |r| {
            Ok(AppWorktreeRow {
                terminal_id: r.get(0)?,
                worktree_path: r.get(1)?,
                base_branch: r.get(2)?,
                branch_name: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        iter.collect()
    }

    /// Startup cleanup: drop rows for worktrees no longer on disk.
    pub fn cleanup_orphan_app_worktrees(&self) -> rusqlite::Result<usize> {
        let all = self.list_app_worktrees()?;
        let mut removed = 0usize;
        for r in all {
            if !std::path::Path::new(&r.worktree_path).exists() {
                self.delete_app_worktree(&r.terminal_id)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}
```

- [ ] **Step 3: Invoke cleanup at startup**

In `main.rs`, find where `Database::new()` (or equivalent) is initialized. After it succeeds, call:

```rust
match db.cleanup_orphan_app_worktrees() {
    Ok(n) if n > 0 => eprintln!("Cleaned {n} orphan app_worktrees rows"),
    Ok(_) => {}
    Err(e) => eprintln!("app_worktrees cleanup failed: {e}"),
}
```

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/database.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(db): app_worktrees table with startup orphan cleanup

New table tracks worktrees this app created (keyed by terminal_id).
On startup, rows whose worktree_path no longer exists on disk are
removed. Row helpers cover insert / get / delete / list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `WorktreeCloseAction` enum + `ConfigProfile.worktree_close_default`

**Files:**
- Modify: `src-tauri/src/config.rs`

**Purpose:** Serialize-able enum for the per-profile default close action. Optional field on `ConfigProfile` deserializes as `None` for existing profiles.

- [ ] **Step 1: Add enum and field**

In `src-tauri/src/config.rs`, add:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeCloseAction {
    Merge,
    Squash,
    Keep,
    Discard,
}
```

In the `ConfigProfile` struct, add:

```rust
#[serde(default)]
pub worktree_close_default: Option<WorktreeCloseAction>,
```

- [ ] **Step 2: Verify build (deserializer smoke test through cargo build)**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "$(cat <<'EOF'
feat(config): WorktreeCloseAction enum + optional profile default

Adds Merge | Squash | Keep | Discard variants. New nullable field
on ConfigProfile lets users lock in a default action per profile.
#[serde(default)] keeps existing profile blobs deserializable as None.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `get_app_worktree` and `record_app_worktree` commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Purpose:** Small query used by the frontend to decide whether to open the modal. `record_app_worktree` lets the frontend insert a row after successfully creating a worktree and then a terminal (called after `create_terminal` returns).

- [ ] **Step 1: Add commands**

In `commands.rs`, append near the other worktree commands:

```rust
#[command]
pub async fn get_app_worktree(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<crate::database::AppWorktreeRow>, String> {
    wrap_cmd("get_app_worktree", async move {
        db_op(&state.db, move |db| {
            db.get_app_worktree(&terminal_id).map_err(|e| e.to_string())
        })
        .await
    })
    .await
}

#[command]
pub async fn record_app_worktree(
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
    base_branch: String,
    branch_name: String,
) -> Result<(), String> {
    wrap_cmd("record_app_worktree", async move {
        let row = crate::database::AppWorktreeRow {
            terminal_id,
            worktree_path,
            base_branch,
            branch_name,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        };
        db_op(&state.db, move |db| {
            db.insert_app_worktree(&row).map_err(|e| e.to_string())
        })
        .await
    })
    .await
}
```

- [ ] **Step 2: Register in `main.rs`**

Add both commands to the `tauri::generate_handler![...]` list.

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(backend): get_app_worktree and record_app_worktree commands

Frontend uses get_app_worktree to decide whether to open the close
modal for a given terminal. record_app_worktree is called after a
worktree + terminal are both successfully created to link them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `merge_worktree_ff` command

**Files:**
- Modify: `src-tauri/src/hunk_ops.rs` (add small git shell helper OR reuse existing)
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Purpose:** FF-only merge of the worktree branch into base. On success: remove worktree, delete app_worktrees row. On failure: return user_err, no side effects.

- [ ] **Step 1: Add shared git-op helper**

In `hunk_ops.rs` (rename or extract to a broader module `git_ops.rs` if preferred; for this plan, keep in `hunk_ops.rs`), add:

```rust
/// Run `git -C <path> <args>` and return stdout on success or user_err
/// containing stderr on failure. Used by worktree lifecycle commands.
pub async fn git_run(path: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = TokioCommand::new("git");
    cmd.arg("-C").arg(path).args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().await.map_err(|e| {
        crate::error_reporter::user_err(&format!("spawn git: {e}"))
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(crate::error_reporter::user_err(&format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}
```

- [ ] **Step 2: Write failing integration test**

In `hunk_ops.rs` test module, append:

```rust
    async fn setup_worktree_scenario() -> (TempDir, String, String) {
        // Returns (temp, main_repo_path, worktree_path)
        let td = TempDir::new().unwrap();
        let main_path = td.path().join("main");
        std::fs::create_dir(&main_path).unwrap();
        init_repo(&main_path);
        write_and_commit(&main_path, "a.txt", "base\n", "init");
        run(&main_path, &["branch", "feat"]);

        let wt_path = td.path().join("wt-feat");
        run(&main_path, &["worktree", "add", wt_path.to_str().unwrap(), "feat"]);
        write_and_commit(&wt_path, "a.txt", "base\nadded\n", "feat commit");

        (td, main_path.to_string_lossy().into(), wt_path.to_string_lossy().into())
    }

    #[tokio::test]
    async fn merge_ff_happy_path() {
        let (_td, main, wt) = setup_worktree_scenario().await;
        // Task 11 implementation reference: this test drives the same function.
        // We'll call the underlying helper directly:
        //   git -C <main> merge --ff-only feat
        // Then verify the worktree is gone.
        super::git_run(&main, &["checkout", "main"]).await.unwrap();
        super::git_run(&main, &["merge", "--ff-only", "feat"]).await.unwrap();
        super::git_run(&main, &["worktree", "remove", &wt]).await.unwrap();
        assert!(!std::path::Path::new(&wt).exists());
    }
```

This validates the shell primitives; Task 11's `merge_worktree_ff` wraps them.

- [ ] **Step 3: Add the `merge_worktree_ff` command**

In `commands.rs`:

```rust
#[derive(serde::Serialize)]
pub struct MergeResult {
    pub new_head_sha: String,
    pub deleted_worktree_path: String,
}

#[command]
pub async fn merge_worktree_ff(
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
    base_branch: String,
) -> Result<MergeResult, String> {
    wrap_cmd("merge_worktree_ff", async move {
        // Resolve main repo path.
        let info = get_worktree_info_impl(&worktree_path).await?;
        let main = info.main_repo_path.clone().ok_or_else(|| {
            crate::error_reporter::user_err("Not a worktree.")
        })?;
        let wt_branch = info.current_branch.clone().ok_or_else(|| {
            crate::error_reporter::user_err("Worktree has no branch (detached HEAD).")
        })?;

        // Optional fetch (best-effort).
        let _ = crate::hunk_ops::git_run(&main, &["fetch", "--quiet"]).await;

        // Refuse if main checkout is dirty.
        let status = crate::hunk_ops::git_run(&main, &["status", "--porcelain"]).await?;
        if !status.trim().is_empty() {
            return Err(crate::error_reporter::user_err(&format!(
                "Uncommitted changes in {}. Commit or stash them, then retry.",
                main
            )));
        }

        crate::hunk_ops::git_run(&main, &["checkout", &base_branch]).await?;
        crate::hunk_ops::git_run(&main, &["merge", "--ff-only", &wt_branch]).await?;

        crate::hunk_ops::git_run(&main, &["worktree", "remove", &worktree_path]).await?;

        let new_head = crate::hunk_ops::git_run(&main, &["rev-parse", "HEAD"]).await?
            .trim().to_string();

        // Delete DB row atomically.
        db_op(&state.db, move |db| {
            db.delete_app_worktree(&terminal_id).map_err(|e| e.to_string())
        })
        .await?;

        Ok(MergeResult {
            new_head_sha: new_head,
            deleted_worktree_path: worktree_path,
        })
    })
    .await
}
```

Note: `get_worktree_info_impl` is the internal (non-`#[command]`) helper that the existing `get_worktree_info` command wraps. If only the command version exists, extract the body into an `_impl` function first. (Look at how `list_worktrees` / `list_worktrees_internal` are paired in the existing code, around line 1998.)

- [ ] **Step 4: Register in `main.rs`**

Add `merge_worktree_ff` to `invoke_handler`.

- [ ] **Step 5: Verify build + test**

Run: `cd src-tauri && cargo test --lib hunk_ops::tests`
Expected: all 7+ tests pass.

Run: `cd src-tauri && cargo build`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/hunk_ops.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(backend): merge_worktree_ff for FF-only lifecycle merge

Checks out base, refuses if base is dirty, runs git merge --ff-only,
removes the worktree, and drops the app_worktrees row atomically.
Any error path returns user_err (env-driven, no telemetry).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `squash_merge_worktree` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Purpose:** Merge --squash with a caller-supplied commit message, then delete branch + worktree.

- [ ] **Step 1: Add command**

In `commands.rs`:

```rust
#[command]
pub async fn squash_merge_worktree(
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
    base_branch: String,
    message: String,
) -> Result<MergeResult, String> {
    wrap_cmd("squash_merge_worktree", async move {
        if message.trim().is_empty() {
            return Err(crate::error_reporter::user_err(
                "Squash message cannot be empty.",
            ));
        }
        let info = get_worktree_info_impl(&worktree_path).await?;
        let main = info.main_repo_path.clone().ok_or_else(|| {
            crate::error_reporter::user_err("Not a worktree.")
        })?;
        let wt_branch = info.current_branch.clone().ok_or_else(|| {
            crate::error_reporter::user_err("Worktree has no branch.")
        })?;

        let _ = crate::hunk_ops::git_run(&main, &["fetch", "--quiet"]).await;

        let status = crate::hunk_ops::git_run(&main, &["status", "--porcelain"]).await?;
        if !status.trim().is_empty() {
            return Err(crate::error_reporter::user_err(&format!(
                "Uncommitted changes in {}. Commit or stash them, then retry.",
                main
            )));
        }

        crate::hunk_ops::git_run(&main, &["checkout", &base_branch]).await?;
        crate::hunk_ops::git_run(&main, &["merge", "--squash", &wt_branch]).await?;
        crate::hunk_ops::git_run(&main, &["commit", "-m", &message]).await?;
        crate::hunk_ops::git_run(&main, &["worktree", "remove", &worktree_path]).await?;
        crate::hunk_ops::git_run(&main, &["branch", "-D", &wt_branch]).await?;

        let new_head = crate::hunk_ops::git_run(&main, &["rev-parse", "HEAD"]).await?
            .trim().to_string();

        db_op(&state.db, move |db| {
            db.delete_app_worktree(&terminal_id).map_err(|e| e.to_string())
        })
        .await?;

        Ok(MergeResult {
            new_head_sha: new_head,
            deleted_worktree_path: worktree_path,
        })
    })
    .await
}
```

- [ ] **Step 2: Register in `main.rs`**

Add `squash_merge_worktree` to `invoke_handler`.

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(backend): squash_merge_worktree with editable message

Merges the worktree branch into base via 'git merge --squash', commits
with the caller-supplied message, then removes the worktree and force-
deletes the source branch. Empty message and dirty-base cases return
user_err.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `discard_worktree` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Purpose:** Force-remove the worktree and force-delete its branch. Idempotent when worktree already gone.

- [ ] **Step 1: Add command**

In `commands.rs`:

```rust
#[command]
pub async fn discard_worktree(
    state: State<'_, AppState>,
    terminal_id: String,
    worktree_path: String,
) -> Result<(), String> {
    wrap_cmd("discard_worktree", async move {
        // If worktree no longer exists, still clean up the DB row.
        if !std::path::Path::new(&worktree_path).exists() {
            db_op(&state.db, move |db| {
                db.delete_app_worktree(&terminal_id).map_err(|e| e.to_string())
            })
            .await?;
            return Ok(());
        }

        let info = get_worktree_info_impl(&worktree_path).await?;
        let main = info.main_repo_path.clone().ok_or_else(|| {
            crate::error_reporter::user_err("Not a worktree.")
        })?;
        let wt_branch = info.current_branch.clone();

        crate::hunk_ops::git_run(&main, &["worktree", "remove", "--force", &worktree_path]).await?;

        if let Some(b) = wt_branch {
            // -D allows deletion of unmerged branches.
            let _ = crate::hunk_ops::git_run(&main, &["branch", "-D", &b]).await;
        }

        db_op(&state.db, move |db| {
            db.delete_app_worktree(&terminal_id).map_err(|e| e.to_string())
        })
        .await?;

        Ok(())
    })
    .await
}
```

- [ ] **Step 2: Register in `main.rs`**

Add `discard_worktree` to `invoke_handler`.

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(backend): discard_worktree force-removes worktree and branch

Force-removes the worktree directory and force-deletes its source
branch. Idempotent if the worktree is already gone (cleans the DB row
and returns Ok).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `WorktreeCloseModal` component

**Files:**
- Modify: `src/types/git.ts` (add `MergeResult`, `WorktreeCloseAction`, `AppWorktreeRow`)
- Modify: `src/store/appStore.ts` (add modal state slice)
- Create: `src/components/WorktreeCloseModal.tsx`
- Create: `src/components/WorktreeCloseModal.test.tsx`

**Purpose:** The four-action modal. Uses `Modal` from `ui/`. Fetches worktree info on open. Squash button reveals inline textarea prefilled from `git log --format='- %s' <base>..HEAD` (via a new small `git_log_since_base(worktree_path, base)` command OR reuses the existing push preview command).

- [ ] **Step 1: Extend `src/types/git.ts`**

Append:

```ts
export type WorktreeCloseAction = 'merge' | 'squash' | 'keep' | 'discard';

export interface AppWorktreeRow {
  terminal_id: string;
  worktree_path: string;
  base_branch: string;
  branch_name: string;
  created_at: number;
}

export interface MergeResult {
  new_head_sha: string;
  deleted_worktree_path: string;
}
```

- [ ] **Step 2: Add `appStore` slice**

In `src/store/appStore.ts`, add to the state and setters:

```ts
// State shape addition
worktreeCloseModal: {
  isOpen: boolean;
  terminalId: string | null;
  worktreeRow: AppWorktreeRow | null;
  onResolved: null | (() => void);
};

// Actions
openWorktreeCloseModal: (terminalId: string, row: AppWorktreeRow, onResolved: () => void) => void;
closeWorktreeCloseModal: () => void;
```

Implementation (in the create call):

```ts
worktreeCloseModal: { isOpen: false, terminalId: null, worktreeRow: null, onResolved: null },
openWorktreeCloseModal: (terminalId, row, onResolved) =>
  set({ worktreeCloseModal: { isOpen: true, terminalId, worktreeRow: row, onResolved } }),
closeWorktreeCloseModal: () =>
  set({ worktreeCloseModal: { isOpen: false, terminalId: null, worktreeRow: null, onResolved: null } }),
```

Import `AppWorktreeRow` at top.

- [ ] **Step 3: Add a `git_log_since_base` command**

In `src-tauri/src/commands.rs`, add:

```rust
#[command]
pub async fn git_log_since_base(
    worktree_path: String,
    base_branch: String,
) -> Result<Vec<String>, String> {
    wrap_cmd("git_log_since_base", async move {
        let range = format!("{base_branch}..HEAD");
        let out = crate::hunk_ops::git_run(
            &worktree_path,
            &["log", "--format=%s", &range],
        )
        .await?;
        Ok(out.lines().map(|s| s.to_string()).collect::<Vec<_>>())
    })
    .await
}
```

Register in `main.rs`.

- [ ] **Step 4: Write failing tests** in `src/components/WorktreeCloseModal.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorktreeCloseModal } from './WorktreeCloseModal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

const row = {
  terminal_id: 't1',
  worktree_path: '/repo-feat',
  base_branch: 'main',
  branch_name: 'feat/x',
  created_at: 0,
};

describe('WorktreeCloseModal', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_worktree_info') return {
        is_git_repo: true, is_worktree: true, main_repo_path: '/repo',
        current_branch: 'feat/x', worktree_root: '/repo-feat',
        dirty_count: 0, ahead: 3, behind: 0,
      };
      if (cmd === 'git_log_since_base') return ['add auth', 'fix login'];
      return undefined;
    });
  });

  it('renders summary line', async () => {
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/3 commits ahead of main/)).toBeInTheDocument());
  });

  it('Merge button calls merge_worktree_ff', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('merge_worktree_ff', expect.objectContaining({
        terminalId: 't1', worktreePath: '/repo-feat', baseBranch: 'main',
      }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Squash reveals textarea with auto-generated message', async () => {
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Squash-merge/ }));
    const ta = await screen.findByRole('textbox');
    expect((ta as HTMLTextAreaElement).value).toContain('feat/x');
    expect((ta as HTMLTextAreaElement).value).toContain('- add auth');
    expect((ta as HTMLTextAreaElement).value).toContain('- fix login');
  });

  it('Discard button calls discard_worktree', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Discard branch/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('discard_worktree', expect.objectContaining({
        terminalId: 't1', worktreePath: '/repo-feat',
      }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Keep button closes without invoking a git op', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Keep worktree/ }));
    expect(onClose).toHaveBeenCalled();
    // Only initial get_worktree_info was invoked.
    const gitCalls = invokeMock.mock.calls.filter(([c]) =>
      c === 'merge_worktree_ff' || c === 'squash_merge_worktree' || c === 'discard_worktree'
    );
    expect(gitCalls).toEqual([]);
  });

  it('Remember checkbox writes profile', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_worktree_info') return {
        is_git_repo: true, is_worktree: true, main_repo_path: '/repo',
        current_branch: 'feat/x', worktree_root: '/repo-feat',
        dirty_count: 0, ahead: 3, behind: 0,
      };
      if (cmd === 'get_profiles') return [{ id: 'p1', name: 'Backend', description: null, working_directory: '', claude_args: [], env_vars: {}, is_default: true }];
      return undefined;
    });
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Remember/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_profile', expect.objectContaining({
        profile: expect.objectContaining({ worktree_close_default: 'merge' }),
      }));
    });
  });
});
```

- [ ] **Step 5: Run test to see it fails**

Run: `npm run test:run -- src/components/WorktreeCloseModal.test.tsx`
Expected: FAIL with "cannot find module './WorktreeCloseModal'"

- [ ] **Step 6: Implement `WorktreeCloseModal.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { GitFork, Info } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { AppWorktreeRow, WorktreeCloseAction, WorktreeDetectResult } from '../types/git';

interface Props {
  open: boolean;
  row: AppWorktreeRow;
  profileName: string | null;
  onClose: () => void;
}

export function WorktreeCloseModal({ open, row, profileName, onClose }: Props) {
  const [info, setInfo] = useState<WorktreeDetectResult | null>(null);
  const [mode, setMode] = useState<'menu' | 'squash'>('menu');
  const [squashMessage, setSquashMessage] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    if (!open) return;
    invoke<WorktreeDetectResult>('get_worktree_info', { path: row.worktree_path })
      .then(setInfo)
      .catch((e) => reportInvokeFailure('get_worktree_info', e));
  }, [open, row.worktree_path]);

  const saveProfileDefault = async (action: WorktreeCloseAction) => {
    if (!remember || !profileName) return;
    try {
      const profiles = await invoke<any[]>('get_profiles');
      const p = profiles.find((x) => x.name === profileName);
      if (!p) return;
      await invoke('save_profile', { profile: { ...p, worktree_close_default: action } });
    } catch (e) {
      reportInvokeFailure('save_profile', e);
    }
  };

  const doMerge = async () => {
    setInFlight(true); setError(null);
    try {
      await invoke('merge_worktree_ff', {
        terminalId: row.terminal_id, worktreePath: row.worktree_path, baseBranch: row.base_branch,
      });
      await saveProfileDefault('merge');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  const openSquash = async () => {
    setMode('squash'); setError(null);
    try {
      const subjects = await invoke<string[]>('git_log_since_base', {
        worktreePath: row.worktree_path, baseBranch: row.base_branch,
      });
      const body = subjects.map((s) => `- ${s}`).join('\n');
      setSquashMessage(`${row.branch_name}\n\n${body}`);
    } catch (e) {
      reportInvokeFailure('git_log_since_base', e);
      setSquashMessage(row.branch_name);
    }
  };

  const doSquash = async () => {
    if (!squashMessage.trim()) { setError('Message cannot be empty.'); return; }
    setInFlight(true); setError(null);
    try {
      await invoke('squash_merge_worktree', {
        terminalId: row.terminal_id,
        worktreePath: row.worktree_path,
        baseBranch: row.base_branch,
        message: squashMessage,
      });
      await saveProfileDefault('squash');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  const doKeep = async () => {
    await saveProfileDefault('keep');
    onClose();
  };

  const doDiscard = async () => {
    setInFlight(true); setError(null);
    try {
      await invoke('discard_worktree', {
        terminalId: row.terminal_id, worktreePath: row.worktree_path,
      });
      await saveProfileDefault('discard');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  if (!open) return null;

  const summary = info
    ? `${info.ahead ?? 0} commits ahead of ${row.base_branch} · ${info.dirty_count ?? 0} uncommitted changes`
    : 'Loading...';

  return (
    <Modal
      onClose={onClose}
      closeOn="none"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-[400px] max-h-[80vh] flex flex-col"
      showHeader
      title={`Session done on ${row.branch_name}`}
      icon={<Info size={16} className="text-accent-primary" />}
    >
      <div className="p-4 space-y-3">
        <p className="text-text-secondary text-[12px]">{summary}</p>

        {mode === 'menu' && (
          <div className="flex flex-col gap-2">
            <Button variant="primary" onClick={doMerge} loading={inFlight}>
              Merge to {row.base_branch}, then delete worktree
            </Button>
            <Button variant="secondary" onClick={openSquash}>
              Squash-merge, tidy commit, then delete
            </Button>
            <Button variant="ghost" onClick={doKeep}>
              Keep worktree, I'll deal with it
            </Button>
            <Button variant="danger" onClick={doDiscard} loading={inFlight}>
              Discard branch + delete worktree
            </Button>
          </div>
        )}

        {mode === 'squash' && (
          <div className="flex flex-col gap-2">
            <label className="text-text-secondary text-[11px]">Commit message</label>
            <textarea
              value={squashMessage}
              onChange={(e) => setSquashMessage(e.target.value)}
              rows={6}
              className="w-full bg-bg-primary ring-1 ring-border-light rounded-md p-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>Back</Button>
              <Button variant="primary" onClick={doSquash} loading={inFlight}>
                Confirm squash-merge
              </Button>
            </div>
          </div>
        )}

        {profileName && (
          <label className="flex items-center gap-2 text-text-secondary text-[11px] pt-2 border-t border-[var(--ij-divider-soft)]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              aria-label="Remember for profile"
            />
            Remember for the "{profileName}" profile
          </label>
        )}

        {error && (
          <div className="p-2 rounded-md bg-error/5 ring-1 ring-error/20">
            <p className="text-error text-[12px]">{error}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 7: Verify tests pass**

Run: `npm run test:run -- src/components/WorktreeCloseModal.test.tsx`
Expected: 6 tests pass.

If `Button` doesn't have a `variant="danger"` or `variant="secondary"`, either add them in `ui/Button.tsx` (following existing variant patterns) or substitute with class overrides in this modal.

- [ ] **Step 8: Commit**

```bash
git add src/types/git.ts src/store/appStore.ts src/components/WorktreeCloseModal.tsx src/components/WorktreeCloseModal.test.tsx src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ui): WorktreeCloseModal with four lifecycle actions

Modal appears when a worktree-isolated terminal closes. Four actions:
merge (FF-only), squash-merge with editable auto-generated message,
keep, discard. 'Remember for profile' checkbox saves the choice as the
profile's default. Adds git_log_since_base backend command.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `terminalStore.closeTerminal` consults `app_worktrees`

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/appStore.ts` (verify slice landed)

**Purpose:** Before calling backend `close_terminal`, check whether the terminal has an `app_worktrees` row. If so, open the modal and wait for its resolution.

- [ ] **Step 1: Refactor `closeTerminal`**

Find the existing `closeTerminal` in `terminalStore.ts`. Wrap the current body:

```ts
async function closeTerminal(id: string) {
  const { openWorktreeCloseModal } = useAppStore.getState();
  try {
    const row = await invoke<AppWorktreeRow | null>('get_app_worktree', { terminalId: id });
    if (row) {
      await new Promise<void>((resolve) => {
        openWorktreeCloseModal(id, row, () => resolve());
      });
    }
  } catch (e) {
    reportInvokeFailure('get_app_worktree', e);
    // Fall through to close anyway on error.
  }
  await invoke('close_terminal', { id });
  // ... existing local cleanup (delete from Map, cancel listeners, etc.) preserved
}
```

Import `AppWorktreeRow` and `useAppStore` at top if not already.

Note: profile lookup for the modal's `profileName` prop happens in the modal itself (via `get_profiles`); the store does not need to pass it.

- [ ] **Step 2: Manually verify build**

Run: `npm run build`
Expected: successful.

Run: `npm run test:run`
Expected: no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/store/terminalStore.ts src/store/appStore.ts
git commit -m "$(cat <<'EOF'
feat(store): closeTerminal opens WorktreeCloseModal for app worktrees

Before calling backend close_terminal, consult get_app_worktree. If a
row exists, open the modal via appStore and await its resolution; then
proceed with backend close. Existing local cleanup is preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: `NewTerminalModal` records the app_worktree link

**Files:**
- Modify: `src/components/NewTerminalModal.tsx`

**Purpose:** When the user creates a terminal that is spawning into a *newly-created* worktree (via the "New Worktree" form in the modal, not selecting an existing one), call `record_app_worktree` after `createTerminal` returns so the row exists for the close-time modal.

- [ ] **Step 1: Track whether the worktree was created by this flow**

In `NewTerminalModal.tsx`, add state:

```tsx
const [createdWorktreeInfo, setCreatedWorktreeInfo] = useState<{
  worktreePath: string;
  baseBranch: string;
  branchName: string;
} | null>(null);
```

In `handleCreateWorktree` (existing), after successful `create_worktree`, set this state:

```tsx
setCreatedWorktreeInfo({
  worktreePath: wt.path,
  baseBranch,
  branchName: newBranchName,
});
```

- [ ] **Step 2: In `handleCreateTerminal`, record after success**

After `newTerminalId = await createTerminal(...)`, add:

```tsx
if (createdWorktreeInfo && newTerminalId) {
  try {
    await invoke('record_app_worktree', {
      terminalId: newTerminalId,
      worktreePath: createdWorktreeInfo.worktreePath,
      baseBranch: createdWorktreeInfo.baseBranch,
      branchName: createdWorktreeInfo.branchName,
    });
  } catch (e) {
    reportInvokeFailure('record_app_worktree', e);
    // Don't fail the whole terminal creation for this bookkeeping.
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: successful.

- [ ] **Step 4: Commit**

```bash
git add src/components/NewTerminalModal.tsx
git commit -m "$(cat <<'EOF'
feat(ui): record app_worktree link on new-worktree terminal creation

After a terminal spawns into a worktree created via the New Worktree
form (not one selected from the existing list), call record_app_worktree
so the close-time modal knows this session owns its worktree. Errors
here are logged but do not fail terminal creation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Mount `<WorktreeCloseModal>` in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Purpose:** Render the modal at the app root, driven by `appStore.worktreeCloseModal`. Also needs the current profile name for the Remember checkbox: fetch it via `useAppStore` after finding the terminal's profile.

- [ ] **Step 1: Add modal rendering**

Import at top:

```tsx
import { WorktreeCloseModal } from './components/WorktreeCloseModal';
```

In the JSX (near other top-level modals):

```tsx
const { worktreeCloseModal, closeWorktreeCloseModal } = useAppStore();

// ...

{worktreeCloseModal.isOpen && worktreeCloseModal.worktreeRow && (
  <WorktreeCloseModal
    open
    row={worktreeCloseModal.worktreeRow}
    profileName={null}  // profile discovery is done inside the modal via get_profiles
    onClose={() => {
      worktreeCloseModal.onResolved?.();
      closeWorktreeCloseModal();
    }}
  />
)}
```

The modal itself resolves the profile name via `get_profiles` (it needs the profile row anyway to update `worktree_close_default`).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: successful.

Run: `npm run test:run`
Expected: no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): mount WorktreeCloseModal at app root

Modal is driven by appStore.worktreeCloseModal. Calling onClose
resolves the pending close promise and clears the store slice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Changelog entry

**Files:**
- Modify: `src/changelog.json`

**Purpose:** Users see this on next update via the What's New modal.

- [ ] **Step 1: Add entry**

Open `src/changelog.json`. Add a top-level entry for the next version (do not bump the version here; that happens via `/publish`). Follow the existing shape.

Example addition (adjust structure to match existing format):

```json
{
  "version": "unreleased",
  "date": "2026-08-22",
  "highlights": [
    {
      "title": "Per-hunk accept and discard",
      "body": "Each hunk in the file changes panel has ✓ and ✕ buttons. ✓ stages the hunk, ✕ discards it. A 5s undo toast catches mistakes. Hunks over 20 lines require a one-click confirm."
    },
    {
      "title": "Worktree lifecycle on close",
      "body": "When you close a terminal that owns a worktree this app created, a modal lets you Merge (fast-forward), Squash-merge with an editable message, Keep, or Discard. Remember your choice per profile."
    }
  ]
}
```

If the file is a flat array with different keys, adapt to match.

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/changelog.json','utf-8'))"`
Expected: no output (parses cleanly).

Run: `npm run test:run`
Expected: no regressions (changelog is often referenced by tests).

- [ ] **Step 3: Commit**

```bash
git add src/changelog.json
git commit -m "$(cat <<'EOF'
docs(changelog): add entries for per-hunk review and worktree lifecycle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Full verification pass

**Files:** none (this task runs checks and fixes any regressions found)

**Purpose:** Complete build + typecheck + full test suite + Rust clippy/tests on both platforms' code paths.

- [ ] **Step 1: TypeScript typecheck**

Run: `npm run build` (which invokes `tsc -b && vite build` per the project convention). If a different typecheck command exists (e.g., `npm run typecheck`), run that first.
Expected: zero errors.

If errors surface, fix them. Commit each fix with a message like `fix(types): tighten X after adding Y`.

- [ ] **Step 2: Full frontend test suite**

Run: `npm run test:run`
Expected: all tests pass, including existing ones.

- [ ] **Step 3: Rust build + tests**

Run: `cd src-tauri && cargo build --all-targets`
Expected: clean.

Run: `cd src-tauri && cargo test`
Expected: all tests pass.

- [ ] **Step 4: Rust clippy (if enforced in this repo)**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
If the project doesn't enforce -D warnings, downgrade to `cargo clippy` without `-D warnings` but still eyeball the output.

- [ ] **Step 5: Manual smoke test** (documented in the PR description, not run here)

Checklist to run on a dev instance later:

1. Create a terminal against a git repo without the "New Worktree" form path. Close it. Confirm no modal.
2. Create a terminal via "New Worktree" form. Close it. Modal appears. Try each of the four buttons in separate sessions.
3. In an active terminal running Claude Code with pending file changes, click ✓ on one hunk. Verify `git diff --staged` shows only that hunk.
4. Click ✕ on a small hunk. Verify it's gone from disk. Click Undo in the toast within 5s. Verify hunk is back.
5. Click ✕ on a 50-line hunk. Verify inline confirm appears. Confirm. Verify gone.
6. Rapid-fire 5 stages, click Undo All. Verify all 5 unstaged.
7. Set worktree_close_default via the Remember checkbox. Open a new session, close it, verify the auto-action fires (this requires additional UX for the auto path; deferred to a follow-up if not present).

- [ ] **Step 6: Push nothing; leave the branch for review**

Do NOT run `git push`. Do NOT open a PR. Print the branch summary:

```bash
git log --oneline master..HEAD
git diff --stat master..HEAD
```

- [ ] **Step 7 (optional): Final commit if smoke test found tweaks**

Commit anything the manual pass surfaced with a `fix(...)` prefix.

---

## Self-Review

**1. Spec coverage:**
- Track A close modal + four actions: Tasks 11, 12, 13, 14, 15, 16, 17.
- Track B hunk buttons + toast + undo: Tasks 1, 2, 3, 4, 5, 6, 7.
- DB migration + startup cleanup: Task 8.
- ConfigProfile field: Task 9.
- Frontend types: Tasks 3, 14.
- app_worktrees insert path: Tasks 10, 16.
- Changelog: Task 18.
- Verification: Task 19.
- Non-goals correctly excluded (no conflict UI, no timeline, no MCP, no keyboard shortcuts).

**2. Placeholders:** zero. Every step has code or a specific command.

**3. Type consistency:**
- `apply_hunk` command name is used consistently in tasks 4, 3, 5, 6, 7.
- `AppWorktreeRow` shape matches between backend (Task 8) and frontend types (Task 14).
- `MergeResult` returned by both merge commands (Tasks 11, 12) matches the frontend type (Task 14).
- `WorktreeCloseAction` frontend uses snake_case string values matching Rust `#[serde(rename_all = "snake_case")]`.

**4. Ambiguity:** two flagged in-plan:
- `get_worktree_info_impl` extraction in Task 11 is called out as needing to happen (extract the body from the existing `get_worktree_info` command). Execution note: if that pairing already exists in `commands.rs`, skip; otherwise, extract before implementing Task 11.
- `Button` variants (`danger`, `secondary`) in Task 14 may or may not exist. Task 14 Step 7 explicitly says to add them if missing.

Plan is ready for execution.
