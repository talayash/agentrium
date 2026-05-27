# Error categorization & gap coverage — design

**Date:** 2026-05-21
**Author:** Tal Ayash
**Status:** Draft → ready for plan

## Background

The `ct-analytics` Cloudflare Worker has been collecting end-user error reports since the [2026-05-07 error reporter rollout](2026-05-07-error-reporter-design.md). The first batch of production data shows two problems:

1. **The dashboard is dominated by user-input validation, not bugs.** Of 11 events in the last 7 days, 10 are command-level `Err(String)` returns that exist precisely to tell the user "your input was invalid" — e.g., `git_pull_branch` returning `"Working tree has uncommitted changes — commit or stash first"`. These are not crashes or unexpected failures, but `wrap_cmd` reports every `Err` indiscriminately.
2. **Several real failure modes are not covered.** PTY reader-thread I/O errors are only logged via `eprintln!`; tauri-plugin-updater failures are silently swallowed in `AutoUpdater.tsx`; 119 `.catch(() => {})` blocks across 34 frontend files quietly drop IPC errors that the user perceives as "the button did nothing."

This spec covers a single PR that fixes both: categorize user-input errors so they're not reported, and instrument the real gaps so we capture the failures that matter.

## Goals

- Stop reporting user-input validation as "errors" on the dashboard.
- Capture PTY reader-thread I/O failures, updater plugin failures, and user-visible IPC failures.
- Preserve the existing `Result<T, String>` contract on every command — no protocol/signature churn.
- Add tests that lock in the new contract.

## Non-goals

- A full `AppError` enum refactor across 105 commands.
- Worker-side changes (the existing 90-day retention will age out historical noise).
- Audit of every frontend `.catch()`. Only user-action invokes (button handlers) are in scope; background pollers stay as-is.
- Adding a new `ErrorSource` variant for user input. User errors are dropped client-side, not relabeled.

## Architecture

Two coordinated changes, plus three targeted gap fills:

1. **Sentinel-prefix categorization.** A new `user_err(msg)` helper returns a `String` with a hidden control-character prefix (`"\x01u\x01"`). `wrap_cmd` detects the sentinel, strips it before returning to the frontend, and **does not** invoke `error_reporter::report`. The frontend sees an identical string — no IPC change.
2. **Gap instrumentation.** PTY reader thread reports its own I/O errors via `report_blocking`. Updater calls in `AutoUpdater.tsx` get wrapped in try/catch with `reportError`. User-initiated `invoke(...).catch(() => {})` sites (button handlers and menu actions) get a shared `reportInvokeFailure` helper. Background pollers and fire-and-forget cleanup are out of scope.
3. **Verification test.** A smoke test that the global panic hook in `main.rs` catches `std::thread::spawn` panics (the PTY reader thread relies on this).

### Why sentinel prefix over `AppError` enum

The cleanest type-system answer would be an `AppError { User(String), Internal(String) }` enum, but the cost is changing 105 command signatures from `Result<T, String>` to `Result<T, AppError>`. Every call site, every `.map_err(|e| e.to_string())`, every test would churn. The sentinel approach is a localized change to `wrap_cmd` plus targeted migration of known offenders. Future commands inherit the pattern by importing `user_err`; nothing else changes.

The control-character prefix `\x01u\x01` is chosen because `\x01` (Start of Heading) never appears in error messages we generate — it's not in path strings, library error formats, or user-facing copy. A doc comment on `user_err` warns against passing untrusted strings that might collide.

## Components

| File | Change |
|---|---|
| `src-tauri/src/error_reporter.rs` | Add `pub const USER_ERR_PREFIX: &str = "\x01u\x01";`, `pub fn user_err(msg: impl Into<String>) -> String`, `pub fn is_user_error(s: &str) -> bool`, `pub fn strip_user_prefix(s: &str) -> &str`. |
| `src-tauri/src/commands.rs` | `wrap_cmd`: if `e.starts_with(USER_ERR_PREFIX)`, return `Err(strip_user_prefix(&e).to_string())` and **skip** the `tokio::spawn(report(...))` call. Migrate the known offenders (see Migration list) to wrap their validation messages in `user_err(...)`. |
| `src-tauri/src/terminal.rs` | In the PTY reader thread, when `reader.read(...)` returns `Err(e)`, call `error_reporter::report_blocking(ErrorSource::RustCommand, Some("pty_reader_error".into()), e.to_string(), None)` before the existing `eprintln!` and terminal banner. Source is `RustCommand` (not `RustPanic`) because the PTY is a command-owned resource and we don't want to pollute the panic stream with background-thread I/O. |
| `src/lib/errorReporter.ts` | Add `reportInvokeFailure(kind: string, err: unknown)` that normalizes `err` to message + stack and forwards to `reportError`. |
| `src/components/AutoUpdater.tsx` | Wrap update-flow calls (check, download, install) so any throw or rejected promise is routed through `reportInvokeFailure('updater_<phase>', err)`. |
| `src/components/*` (targeted audit) | Replace `.catch(() => {})` with `.catch((e) => reportInvokeFailure('<command>', e))` on user-initiated invokes only. |
| `src-tauri/src/error_reporter.rs` (tests) | Unit tests for the new helpers and the wrap-cmd skip-on-user-err behavior. |
| `src-tauri/src/main.rs` (test) | Smoke test that a `std::thread::spawn` panic triggers the global hook. |

## Data flow

**User-error path (new):**
```
command body returns Err(user_err("Working tree dirty"))
    │
    ▼
wrap_cmd detects USER_ERR_PREFIX
    │
    ├─► strip prefix → return Err("Working tree dirty") to frontend
    │
    └─► (skip report() — nothing sent to Worker)
```

**Internal-error path (unchanged):**
```
command body returns Err("DB connection failed".to_string())
    │
    ▼
wrap_cmd sees no prefix
    │
    ├─► tokio::spawn(error_reporter::report(RustCommand, name, msg))
    │
    └─► return Err("DB connection failed") to frontend
```

**PTY reader I/O error (new path):**
```
reader.read() → Err(io_err)
    │
    ├─► report_blocking(RustCommand, "pty_reader_error", io_err.to_string(), None)
    │
    ├─► tx.blocking_send terminal-banner ("[Error reading from terminal: …]")
    │
    └─► break reader loop
```

## Migration list (known offenders only)

The five fingerprints that polluted the last 7 days of telemetry:

| Command | Current `Err` shape | Action |
|---|---|---|
| `git_pull_branch` | `"Working tree has uncommitted changes — commit or stash first, then pull."` | Wrap in `user_err(...)`. |
| `scan_git_repos` | `"Invalid path '<x>': The system cannot find the file specified. (os error 2)"` | Wrap in `user_err(...)` when the path came from frontend args. |
| `git_list_stashes` | same shape | Wrap in `user_err(...)`. |
| `list_package_scripts` | same shape | Wrap in `user_err(...)`. |
| `get_worktree_info` | `"Path '<x>' is not under any active terminal's working directory"` | Wrap in `user_err(...)`. |

Per-site judgment: each command is inspected to confirm the message is genuinely produced for user-supplied input. Internal-path failures (config dir, DB file, etc.) using the same `os error 2` shape stay un-prefixed because they're real bugs.

## Error handling

- **Prefix collision:** `\x01` is a control character that does not appear in any error message produced by our code, the `std` library, or our dependencies' `Display` impls for filesystem/network errors. A `///` doc-comment on `user_err` notes this contract so future callers don't pass untrusted strings.
- **Existing behavior preserved:** Strings without the prefix pass through `wrap_cmd` exactly as before. The change is additive.
- **PTY reader reporting** uses `report_blocking` because the reader runs on `std::thread::spawn`, not a Tokio runtime. The 5-second timeout inside `report()` bounds the wait.
- **Frontend reporter cannot recurse:** `reportInvokeFailure` calls `reportError`, which already swallows its own `invoke('report_error', ...)` rejection with `.catch(() => {})`. No feedback loop.
- **Updater plugin coverage:** wrapping calls in `AutoUpdater.tsx` captures both thrown exceptions and rejected promises. Specific kinds: `updater_check`, `updater_download`, `updater_install`.

## Testing

Existing tests stay green. New tests:

- `user_err("x")` returns a string starting with `USER_ERR_PREFIX`.
- `strip_user_prefix(&user_err("x"))` returns `"x"`.
- `strip_user_prefix("ordinary")` returns `"ordinary"` (passthrough).
- `is_user_error(&user_err("x"))` → true; `is_user_error("ordinary")` → false.
- `wrap_cmd` returns the unprefixed message to the caller when the body returns a user error.
- `wrap_cmd` does not call `error_reporter::report` for user errors. Implementation: extract the "should report?" decision into a pure helper (`fn should_report(err: &str) -> bool { !is_user_error(err) }`) and test that directly, since the reporter itself is global state.
- A `std::thread::spawn(|| panic!("test"))` inside the panic-hook smoke test triggers the hook (verified by setting a flag the test reads). Run only in debug builds to avoid disturbing release behavior.

Frontend tests for `reportInvokeFailure` are skipped — the function is a thin normalization wrapper around the existing `reportError` (which is already covered by smoke tests).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A future contributor produces an error message that happens to start with `\x01u\x01`. | Doc comment on `user_err` warns about the contract. Realistically `\x01` won't appear — no real library prepends control characters. |
| Migration mis-classifies a real bug as user input. | Inspection per site. If wrong, the command's `Err` still flows correctly to the frontend — we just lose telemetry signal on that one shape. Easy to revert per-site. |
| Reporter helper `should_report` drifts from `wrap_cmd`'s implementation. | Put the helper in `error_reporter.rs` and have `wrap_cmd` call it. Single source of truth. |
| PTY reader-error reporting floods telemetry if a user has a flaky terminal. | The existing 60-second dedup window in `error_reporter::Dedup` covers this — repeated identical I/O errors collapse to one report per minute. |
| Frontend audit scope creep. | Hard rule: only user-initiated invokes (button handlers, menu actions). Background pollers and fire-and-forget cleanup stay as-is. |

## Out of scope

- Worker-side changes. Existing 90-day data ages out.
- `AppError` enum refactor.
- Audit of all 119 frontend `.catch()` blocks.
- New `ErrorSource` variant for user input.
- Changes to scrubbing, fingerprinting, or dedup.

## Open questions

None at design time. Implementation will surface per-site judgment calls for the migration list — those are handled inline against this design.
