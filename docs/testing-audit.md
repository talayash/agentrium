# Test coverage audit — 2026-09-10

This pass reviewed the test inventory, application lifecycle wiring, hooks,
stores, desktop window helpers, Rust test coverage, worker tests, and CI.
It adds targeted unit and integration tests; it does not establish complete
statement coverage or run the packaged desktop application end to end.

## Added coverage

| Suite | Tests | Behavior protected |
| --- | ---: | --- |
| `src/hooks/useWindowFocused.test.ts` | 5 | Initial focus, events, native failures, delayed registration cleanup, stale responses |
| `src/hooks/useNowTick.test.ts` | 4 | Activity ticks, idle suspension, restart, timer cleanup |
| `src/hooks/usePreventWebviewReload.test.ts` | 5 | Native menus on editable surfaces, live terminal checks, global handler cleanup |
| `src/hooks/useSessionStateDetection.test.ts` | 8 | Busy/waiting transitions, notification deduplication and rearming, focus, DND, sound, stopped sessions, unmounted buffers |
| `src/lib/windowLayout.test.ts` | 11 | Stable identities, independent window updates, corrupt storage recovery, geometry, unavailable native windows |
| `src/lib/tabTransfer.test.ts` | 12 | Window hit testing, overlay exclusion, handoff failures, scrollback adoption, acknowledgements, listener cleanup |
| `src/store/pasteStore.test.ts` | 5 | Ordering, preview/history limits, immutable updates, terminal isolation, disk hydration failures |

The new regression tests failed before fixes for two focus lifecycle defects
(late listener registration and stale initial focus queries) and malformed
saved layouts. Layout reads now validate entries and discard invalid geometry
while retaining valid session identities.

CI now runs the analytics worker's existing test suite independently of the
frontend and Rust jobs.

## Validation

- `npm.cmd run test:run`: 554 tests passed in 65 files (baseline: 504 in 58).
- `npm.cmd run build`: TypeScript and production bundling passed. Vite reported
  large chunks and ineffective dynamic imports; bundle optimization remains separate work.
- `cargo test --locked --offline` in `src-tauri`: 267 tests passed.
- `npm.cmd run test:run` in `workers/ct-analytics`: 15 tests passed.

Use `npm` instead of `npm.cmd` on Linux/macOS. The `.cmd` entry point avoids
PowerShell's script execution restriction on this development machine.

## Highest-value follow-up coverage

| Priority | Area | Scenarios to exercise |
| --- | --- | --- |
| High | Packaged desktop lifecycle (`App.tsx`, `TerminalView.tsx`) | Launch, create a real shell, receive output, close, restart, restore; verify cleanup and persisted state across actual processes |
| High | Multi-window failure recovery (`tabTransfer.ts`) | Destination creation fails after source detachment; receiver closes mid-adoption; transfers contain missing terminal IDs; verify tabs remain recoverable |
| High | Editor and LSP (`FileEditorView.tsx`, `lspClient.ts`) | Unsaved-file close prompts, save failures, delayed document opens, debounced changes, diagnostics arriving after close |
| High | Keyboard dispatch (`useKeyboardShortcuts.ts`) | Editable controls versus terminal focus, modal priority, platform modifiers, subscriber cleanup |
| Medium | Paste hydration concurrency (`pasteStore.ts`) | Add/remove/clear while a disk read is in flight; overlapping reads resolving out of order |
| Medium | Worker HTTP routes (`workers/ct-analytics/src/index.ts`) | Request validation, rate limiting, database failures and response contracts using isolated database fixtures |
| Medium | UI workflows | Setup, workspace/worktree creation, global search, Git operations and update failure/retry flows |

The new desktop integration tests mock Tauri boundaries. They verify frontend
decisions and protocol ordering, but cannot validate native window creation,
OS notification delivery, real PTY lifetime, or cross-window event delivery.
The CI change was inspected locally; its hosted execution will occur on the
next push or pull request.
