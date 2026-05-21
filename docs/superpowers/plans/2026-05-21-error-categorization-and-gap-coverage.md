# Error Categorization & Gap Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reporting user-input validation as errors, and instrument three previously-uncovered failure paths (PTY reader I/O, updater plugin, user-action IPC).

**Architecture:** Sentinel-prefix `String` helper in `error_reporter.rs` lets commands tag user-input errors. `wrap_cmd` strips the prefix and skips telemetry. A migration of one shared helper (`validate_path_is_trusted`) + one inline `Err` in `git_pull_branch` covers all five known noisy fingerprints. Gap fills are localized to `terminal.rs` (PTY reader thread) and the frontend updater store + a small set of user-action `.catch()` sites.

**Tech Stack:** Rust 2021, Tauri 2.x, React 18 / TypeScript, Vite, tokio.

**Spec:** `docs/superpowers/specs/2026-05-21-error-categorization-and-gap-coverage-design.md`

---

## File Structure

**Modify:**
- `src-tauri/src/error_reporter.rs` — add `USER_ERR_PREFIX`, `user_err`, `is_user_error`, `strip_user_prefix`, `should_report` + unit tests
- `src-tauri/src/commands.rs` — `wrap_cmd` calls `should_report` to decide whether to fire telemetry; strips prefix before returning to frontend. Migrate `validate_path_is_trusted` (line 1476) and `git_pull_branch` dirty-tree return (line 3452) to use `user_err`.
- `src-tauri/src/terminal.rs` — PTY reader thread reports `Err` from `reader.read(...)` via `error_reporter::report_blocking` (line ~268).
- `src-tauri/src/main.rs` — add an integration test verifying the global panic hook fires from a `std::thread::spawn` panic.
- `src/lib/errorReporter.ts` — add `reportInvokeFailure(kind, err)` helper.
- `src/store/updaterStore.ts` — report telemetry from the `checkForUpdates`, `downloadAndInstall`, and `restart` catch blocks.
- `src/components/AutoUpdater.tsx` — replace `send_notification` `.catch(() => {})` with `reportInvokeFailure` route.
- `src/main.tsx` — no change (already wired).

No new files except the design/plan docs already created.

---

## Task 1: Helpers and unit tests in `error_reporter.rs`

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

- [ ] **Step 1.1: Add the failing tests**

Append inside the existing `mod tests` block in `src-tauri/src/error_reporter.rs` (before the closing `}`):

```rust
    #[test]
    fn user_err_round_trips_via_strip() {
        let e = user_err("Working tree dirty");
        assert!(e.starts_with(USER_ERR_PREFIX));
        assert_eq!(strip_user_prefix(&e), "Working tree dirty");
    }

    #[test]
    fn strip_user_prefix_passthrough_for_plain_strings() {
        assert_eq!(strip_user_prefix("ordinary error"), "ordinary error");
    }

    #[test]
    fn is_user_error_detects_prefixed_string() {
        assert!(is_user_error(&user_err("x")));
        assert!(!is_user_error("plain"));
        assert!(!is_user_error(""));
    }

    #[test]
    fn should_report_skips_user_errors() {
        assert!(!should_report(&user_err("validation")));
    }

    #[test]
    fn should_report_keeps_internal_errors() {
        assert!(should_report("DB connection refused"));
    }
```

- [ ] **Step 1.2: Run the new tests to verify they fail**

Run from `src-tauri/`:

```
cargo test --lib error_reporter::tests::user_err_round_trips_via_strip
```

Expected: FAIL — `cannot find function user_err` and similar errors for the other tests. (Run `cargo test --lib error_reporter` to see all failing tests at once.)

- [ ] **Step 1.3: Add the helpers**

Add to `src-tauri/src/error_reporter.rs`, immediately above the existing `pub fn scrub(...)` definition (currently at line 18):

```rust
/// Marker prefix used to tag a `Result::Err(String)` as user-input validation
/// rather than an internal bug. `wrap_cmd` detects this prefix and:
///   1. strips it before returning the error to the frontend (so UI is unchanged), and
///   2. skips telemetry reporting.
/// `\x01` (SOH) is a control character that does not appear in any error
/// message we generate or any library `Display` impl we depend on. Do NOT
/// build `user_err` strings from untrusted external input.
pub const USER_ERR_PREFIX: &str = "\x01u\x01";

/// Tag `msg` as a user-input validation error. The returned `String` is what
/// you should return from a command body via `Err(user_err(...))`.
pub fn user_err(msg: impl Into<String>) -> String {
    let mut s = String::from(USER_ERR_PREFIX);
    s.push_str(&msg.into());
    s
}

/// True if `s` was produced by `user_err`.
pub fn is_user_error(s: &str) -> bool {
    s.starts_with(USER_ERR_PREFIX)
}

/// Return the original message without the `USER_ERR_PREFIX` if present;
/// otherwise return the input unchanged. Allocation-free in the common case.
pub fn strip_user_prefix(s: &str) -> &str {
    s.strip_prefix(USER_ERR_PREFIX).unwrap_or(s)
}

/// Single source of truth: should this `Err(String)` be sent to telemetry?
/// `wrap_cmd` calls this so the rule lives next to the helpers.
pub fn should_report(err: &str) -> bool {
    !is_user_error(err)
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run from `src-tauri/`:

```
cargo test --lib error_reporter
```

Expected: all tests in `error_reporter::tests` pass, including the five new ones.

- [ ] **Step 1.5: Commit**

```
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error-reporter): add user_err helper and should_report decision point"
```

---

## Task 2: Wire `should_report` into `wrap_cmd`

**Files:**
- Modify: `src-tauri/src/commands.rs` (lines 11-29 — the `wrap_cmd` function)

- [ ] **Step 2.1: Read the current `wrap_cmd` body**

Open `src-tauri/src/commands.rs`. Confirm the current `wrap_cmd` body (lines 13-29) matches:

```rust
pub async fn wrap_cmd<T, F>(name: &'static str, fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match fut.await {
        Ok(v) => Ok(v),
        Err(e) => {
            tokio::spawn(error_reporter::report(
                ErrorSource::RustCommand,
                Some(name.to_string()),
                e.clone(),
                None,
            ));
            Err(e)
        }
    }
}
```

- [ ] **Step 2.2: Replace `wrap_cmd` body**

Change lines 13-29 to:

```rust
pub async fn wrap_cmd<T, F>(name: &'static str, fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match fut.await {
        Ok(v) => Ok(v),
        Err(e) => {
            if error_reporter::should_report(&e) {
                tokio::spawn(error_reporter::report(
                    ErrorSource::RustCommand,
                    Some(name.to_string()),
                    e.clone(),
                    None,
                ));
                Err(e)
            } else {
                // User-input error: strip the marker prefix so the frontend
                // sees a plain message, and skip telemetry.
                Err(error_reporter::strip_user_prefix(&e).to_string())
            }
        }
    }
}
```

- [ ] **Step 2.3: Verify it compiles**

Run from `src-tauri/`:

```
cargo check
```

Expected: clean compile, no new warnings.

- [ ] **Step 2.4: Add an integration-style test for `wrap_cmd`**

In `src-tauri/src/commands.rs`, append at the end of the file:

```rust
#[cfg(test)]
mod wrap_cmd_tests {
    use super::*;

    #[tokio::test]
    async fn wrap_cmd_strips_prefix_from_user_error() {
        let result: Result<(), String> = wrap_cmd("dummy", async {
            Err(error_reporter::user_err("input was bad"))
        }).await;
        assert_eq!(result, Err("input was bad".to_string()));
    }

    #[tokio::test]
    async fn wrap_cmd_passes_through_internal_error_unchanged() {
        let result: Result<(), String> = wrap_cmd("dummy", async {
            Err("io failure".to_string())
        }).await;
        assert_eq!(result, Err("io failure".to_string()));
    }

    #[tokio::test]
    async fn wrap_cmd_passes_through_ok_unchanged() {
        let result: Result<i32, String> = wrap_cmd("dummy", async { Ok(42) }).await;
        assert_eq!(result, Ok(42));
    }
}
```

- [ ] **Step 2.5: Run the new tests**

Run from `src-tauri/`:

```
cargo test --lib wrap_cmd_tests
```

Expected: all three tests pass.

- [ ] **Step 2.6: Commit**

```
git add src-tauri/src/commands.rs
git commit -m "feat(wrap-cmd): skip telemetry and strip prefix for user_err results"
```

---

## Task 3: Migrate known offenders to `user_err`

**Files:**
- Modify: `src-tauri/src/commands.rs` lines 1476-1502 (`validate_path_is_trusted`) and line 3452 (`git_pull_branch` dirty-tree)

These two changes cover all five fingerprints from the production data:
- `validate_path_is_trusted` is called from ~30 sites including `scan_git_repos`, `git_list_stashes`, `list_package_scripts`, and `get_worktree_info` — both `"Invalid path '...'"` and `"...not under any active terminal's working directory"` come from here.
- `git_pull_branch` has its own dirty-tree validation at line 3452.

- [ ] **Step 3.1: Migrate `validate_path_is_trusted` (line 1476)**

In `src-tauri/src/commands.rs`, change the two `Err(...)` paths inside `validate_path_is_trusted`:

Replace line 1479:

```rust
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
```

with:

```rust
        .map_err(|e| error_reporter::user_err(format!("Invalid path '{}': {}", path, e)))?;
```

And replace lines 1495-1500:

```rust
    if !is_trusted {
        return Err(format!(
            "Path '{}' is not under any active terminal's working directory",
            canonical_path.display()
        ));
    }
```

with:

```rust
    if !is_trusted {
        return Err(error_reporter::user_err(format!(
            "Path '{}' is not under any active terminal's working directory",
            canonical_path.display()
        )));
    }
```

- [ ] **Step 3.2: Migrate `git_pull_branch` dirty-tree return (line 3452)**

In the same file, replace lines 3450-3453:

```rust
        if is_dirty && !auto_stash {
            return Err(
                "Working tree has uncommitted changes — commit or stash first, then pull.".into(),
            );
        }
```

with:

```rust
        if is_dirty && !auto_stash {
            return Err(error_reporter::user_err(
                "Working tree has uncommitted changes — commit or stash first, then pull.",
            ));
        }
```

- [ ] **Step 3.3: Verify it compiles**

Run from `src-tauri/`:

```
cargo check
```

Expected: clean compile.

- [ ] **Step 3.4: Add a test that documents the contract**

Append to the existing `wrap_cmd_tests` module at the end of `src-tauri/src/commands.rs`:

```rust
    #[tokio::test]
    async fn wrap_cmd_passes_through_validate_path_is_trusted_error_clean() {
        // Document that callers see the same string they would have before
        // migration. The prefix is stripped invisibly.
        let inner_msg = "Invalid path 'agentic-dev': not found";
        let result: Result<(), String> = wrap_cmd("scan_git_repos", async {
            Err(error_reporter::user_err(inner_msg))
        }).await;
        assert_eq!(result, Err(inner_msg.to_string()));
    }
```

- [ ] **Step 3.5: Run all error_reporter and wrap_cmd tests**

Run from `src-tauri/`:

```
cargo test --lib error_reporter
cargo test --lib wrap_cmd_tests
```

Expected: all green.

- [ ] **Step 3.6: Commit**

```
git add src-tauri/src/commands.rs
git commit -m "fix(telemetry): mark path-validation and dirty-tree errors as user input"
```

---

## Task 4: PTY reader thread reports I/O errors

**Files:**
- Modify: `src-tauri/src/terminal.rs` (around line 267-275)

- [ ] **Step 4.1: Confirm current reader-thread error handling**

Open `src-tauri/src/terminal.rs`. Lines 267-275 should read:

```rust
                    Err(e) => {
                        eprintln!("Error reading from pty: {}", e);
                        let _ = tx.blocking_send((
                            terminal_id.clone(),
                            format!("\r\n[Error reading from terminal: {}]\r\n", e).into_bytes(),
                        ));
                        break;
                    }
```

- [ ] **Step 4.2: Add a `use` import for the error reporter**

Find the top of `src-tauri/src/terminal.rs` and add this import alongside the others (after the existing `use crate::config::...` line, near the top of the file):

```rust
use crate::error_reporter::{self, ErrorSource};
```

If `crate::error_reporter` is already imported, skip this step.

- [ ] **Step 4.3: Report the I/O error before the existing behavior**

Replace the `Err(e)` arm (lines 267-275) with:

```rust
                    Err(e) => {
                        eprintln!("Error reading from pty: {}", e);
                        // Capture so we hear about broken-mid-session terminals.
                        // RustCommand (not RustPanic) because the PTY is a
                        // command-owned resource; we don't want to pollute the
                        // panic stream with background-thread I/O. The 60s
                        // dedup window in the reporter collapses repeated
                        // identical errors.
                        error_reporter::report_blocking(
                            ErrorSource::RustCommand,
                            Some("pty_reader_error".to_string()),
                            e.to_string(),
                            None,
                        );
                        let _ = tx.blocking_send((
                            terminal_id.clone(),
                            format!("\r\n[Error reading from terminal: {}]\r\n", e).into_bytes(),
                        ));
                        break;
                    }
```

- [ ] **Step 4.4: Verify it compiles**

Run from `src-tauri/`:

```
cargo check
```

Expected: clean compile. If `error_reporter` was not previously imported in `terminal.rs`, the `use` from step 4.2 makes this work.

- [ ] **Step 4.5: Commit**

```
git add src-tauri/src/terminal.rs
git commit -m "feat(telemetry): report PTY reader-thread I/O errors"
```

---

## Task 5: Smoke test that the panic hook catches thread panics

**Files:**
- Modify: `src-tauri/src/main.rs` (existing panic hook is at lines 35-45)

The point of this test is to lock in that `std::panic::set_hook` (set in `main.rs`) fires from background-thread panics. The PTY reader runs on a `std::thread::spawn` thread — we need to know its panics are visible to telemetry.

- [ ] **Step 5.1: Read the current panic hook setup**

Open `src-tauri/src/main.rs`. Confirm the panic hook is registered via `std::panic::set_hook(Box::new(|info| { ... }))` and calls `error_reporter::report_blocking(ErrorSource::RustPanic, ...)`.

- [ ] **Step 5.2: Add a `#[cfg(test)]` smoke test**

Append at the end of `src-tauri/src/main.rs`:

```rust
#[cfg(test)]
mod panic_hook_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Smoke test: a panic inside `std::thread::spawn` is visible to the
    /// default panic hook (and therefore to our `set_hook` in `main`). We
    /// don't install the real hook here — that would race with other tests
    /// and need ErrorReporter init. Instead we set our own hook for the
    /// duration of the test, panic on a worker thread, and assert the hook
    /// fired.
    #[test]
    fn thread_spawn_panic_invokes_global_hook() {
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();

        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |_info| {
            fired_clone.store(true, Ordering::SeqCst);
        }));

        let handle = std::thread::spawn(|| {
            panic!("intentional thread-panic for hook coverage");
        });
        // The join returns Err on a panicked thread; that's expected.
        let _ = handle.join();

        // Restore so other tests aren't affected.
        std::panic::set_hook(prev);

        assert!(
            fired.load(Ordering::SeqCst),
            "global panic hook did not fire from a std::thread::spawn panic"
        );
    }
}
```

- [ ] **Step 5.3: Run the smoke test**

Run from `src-tauri/`:

```
cargo test --bin claude-terminal panic_hook_tests
```

(Adjust the bin name if `Cargo.toml` uses a different one — `cargo test panic_hook_tests` from `src-tauri/` works regardless.)

Expected: PASS — the assertion confirms the hook fires.

- [ ] **Step 5.4: Commit**

```
git add src-tauri/src/main.rs
git commit -m "test: lock in that thread::spawn panics reach the global panic hook"
```

---

## Task 6: Frontend `reportInvokeFailure` helper

**Files:**
- Modify: `src/lib/errorReporter.ts`

- [ ] **Step 6.1: Append the helper**

Append to the end of `src/lib/errorReporter.ts` (after the existing `clamp` function):

```typescript
/**
 * Convenience wrapper for `.catch` handlers on user-action `invoke(...)` calls.
 * Normalizes the rejection value into a message + stack and forwards to
 * `reportError`. Background pollers should NOT use this — only user-visible
 * actions where a silent failure is a user-facing bug.
 */
export function reportInvokeFailure(kind: string, err: unknown): void {
  if (err instanceof Error) {
    reportError(kind, err.message, err.stack);
    return;
  }
  if (typeof err === 'string') {
    reportError(kind, err);
    return;
  }
  // Anything else (object, undefined, number, etc.) — coerce safely.
  let message: string;
  try {
    message = JSON.stringify(err);
  } catch {
    message = String(err);
  }
  reportError(kind, message);
}
```

- [ ] **Step 6.2: Verify TypeScript compiles**

Run from the repo root:

```
npm run -s build -- --mode=production 2>&1 | head -50
```

Or, faster, just type-check:

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6.3: Commit**

```
git add src/lib/errorReporter.ts
git commit -m "feat(frontend): add reportInvokeFailure helper for user-action invoke catches"
```

---

## Task 7: Updater store reports plugin failures

**Files:**
- Modify: `src/store/updaterStore.ts`

Today the store catches errors and surfaces them in UI state (`status: 'error'`, `error: msg`) but never sends them to telemetry. We add `reportInvokeFailure` in each catch.

- [ ] **Step 7.1: Add the import**

At the top of `src/store/updaterStore.ts`, alongside the existing imports, add:

```typescript
import { reportInvokeFailure } from '../lib/errorReporter';
```

- [ ] **Step 7.2: Report in `checkForUpdates`**

Find the `catch (err) { ... }` block inside `checkForUpdates` (currently lines 92-98). Replace:

```typescript
    } catch (err) {
      console.error('Update check failed:', err);
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to check for updates',
      });
      return { available: false };
    }
```

with:

```typescript
    } catch (err) {
      console.error('Update check failed:', err);
      reportInvokeFailure('updater_check', err);
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to check for updates',
      });
      return { available: false };
    }
```

- [ ] **Step 7.3: Report in `downloadAndInstall`**

Find the `catch (err) { ... }` block in `downloadAndInstall` (lines 133-138). Replace:

```typescript
    } catch (err) {
      console.error('Update download failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: `Failed to auto-update: ${msg}. Please download manually.` });
      return false;
    }
```

with:

```typescript
    } catch (err) {
      console.error('Update download failed:', err);
      reportInvokeFailure('updater_download_install', err);
      const msg = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: `Failed to auto-update: ${msg}. Please download manually.` });
      return false;
    }
```

- [ ] **Step 7.4: Report in `restart`**

Find the `restart` async function (lines 141-153). Replace:

```typescript
  restart: async () => {
    try {
      await invoke('save_session_for_restore');
    } catch (err) {
      console.error('Failed to save session before restart:', err);
    }
    try {
      await relaunch();
    } catch (err) {
      console.error('Failed to restart:', err);
      set({ error: 'Failed to restart. Please restart manually.' });
    }
  },
```

with:

```typescript
  restart: async () => {
    try {
      await invoke('save_session_for_restore');
    } catch (err) {
      console.error('Failed to save session before restart:', err);
      reportInvokeFailure('save_session_for_restore', err);
    }
    try {
      await relaunch();
    } catch (err) {
      console.error('Failed to restart:', err);
      reportInvokeFailure('updater_restart', err);
      set({ error: 'Failed to restart. Please restart manually.' });
    }
  },
```

- [ ] **Step 7.5: Verify TypeScript compiles**

Run:

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7.6: Commit**

```
git add src/store/updaterStore.ts
git commit -m "feat(telemetry): report updater check/download/restart failures"
```

---

## Task 8: Targeted frontend `.catch(() => {})` audit

**Files:**
- Modify: `src/components/AutoUpdater.tsx` (the `send_notification` catch at line 92)

Scope this task narrowly to the highest-value site: the desktop-notification invoke. Background pollers and store-side catches are out of scope (and the updater store already covered above).

- [ ] **Step 8.1: Replace the `send_notification` catch in AutoUpdater.tsx**

In `src/components/AutoUpdater.tsx`, find lines 89-95:

```typescript
    void invoke('send_notification', {
      title: 'ClaudeTerminal update available',
      body: `Version ${updateInfo.version} is ready to install. Open the app to update.`,
    }).catch(() => {
      // Notification failures are non-fatal — the in-app banner still shows.
    });
```

Replace with:

```typescript
    void invoke('send_notification', {
      title: 'ClaudeTerminal update available',
      body: `Version ${updateInfo.version} is ready to install. Open the app to update.`,
    }).catch((err) => {
      // Notification failures are non-fatal — the in-app banner still shows.
      // We still report so we know if the OS notification path is broken.
      reportInvokeFailure('send_notification', err);
    });
```

- [ ] **Step 8.2: Add the import to AutoUpdater.tsx**

At the top of `src/components/AutoUpdater.tsx` (alongside the existing imports), add:

```typescript
import { reportInvokeFailure } from '../lib/errorReporter';
```

- [ ] **Step 8.3: Verify TypeScript compiles**

Run:

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 8.4: Commit**

```
git add src/components/AutoUpdater.tsx
git commit -m "feat(telemetry): report send_notification failures from AutoUpdater"
```

---

## Task 9: Full verification & push

- [ ] **Step 9.1: Run the full Rust test suite**

From `src-tauri/`:

```
cargo test
```

Expected: every test in the workspace passes. If anything fails, fix it before moving on — don't proceed with failures.

- [ ] **Step 9.2: Type-check the frontend**

From repo root:

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 9.3: Run frontend tests**

From repo root:

```
npm test -- --run
```

Expected: green. (If Vitest is the runner — confirm via `package.json` if needed.)

- [ ] **Step 9.4: Production-build sanity check**

From repo root:

```
npm run build
```

Expected: build succeeds. This compiles the frontend and verifies Vite/TypeScript end-to-end. Do NOT run `npm run tauri build` (slower, signing required) — `npm run build` is enough to catch frontend regressions.

From `src-tauri/`:

```
cargo check
```

Expected: clean compile.

- [ ] **Step 9.5: Git status check**

```
git status
```

Expected: clean working tree (all changes committed in tasks 1-8). If anything is left uncommitted, decide whether to fold it into a new commit or amend; don't push half-finished work.

- [ ] **Step 9.6: Push**

```
git push origin master
```

Expected: pushes commits from tasks 1-8. The repo's `.github/workflows/release.yml` is tag-triggered, not push-triggered, so this push does not cut a release — that happens later via `/publish`.

---

## Self-review notes

- **Spec coverage:** Architecture (sentinel prefix + 3 gap fills + verification test) covered by Tasks 1, 2, 4, 5, 6, 7, 8. Migration list (5 fingerprints) covered by Task 3 — `validate_path_is_trusted` handles 4 of 5; `git_pull_branch` is the 5th.
- **Placeholder scan:** All steps have exact paths, exact code, exact commands. No "TBD" or "fill in details."
- **Type consistency:** `user_err`, `is_user_error`, `strip_user_prefix`, `should_report`, `USER_ERR_PREFIX` named the same in every reference. `reportInvokeFailure(kind: string, err: unknown)` signature is consistent across Tasks 6, 7, 8.
- **Scope check:** Single PR, single subsystem (error telemetry). No decomposition needed.
- **Frontend audit scope:** Bounded to the spec — updater store + one AutoUpdater catch. Other `.catch(() => {})` blocks are deliberately left as future work.
