# Codebase audit — 2026-09-10

Reviewed the React frontend, Rust/Tauri command layer, terminal/session and window lifecycle, editor, Git operations, preview configuration, and analytics worker. The findings below describe the reviewed baseline; all nine are addressed by the accompanying changes.

## Fix verification

- Frontend: 565 tests passed across 67 files.
- Rust: 271 tests passed, including literal Git paths, unborn repositories, and safe directory-link deletion.
- Analytics worker: 15 tests passed.
- Production frontend build and diff whitespace checks passed. Existing bundle-size/dynamic-import warnings remain.
- Headless Chromium with mocked Tauri IPC verified 24px editor text after selecting 24px, a write on file-tab blur, and confirmation/cancellation preserving a dirty file on keyboard close. The configured production CSP allowed a local iframe to load without policy violations.
- Native multi-window and agent CLI integration still require desktop validation. On this Windows host, directory junction deletion was exercised; unprivileged file-symlink creation is unavailable. The Unix regression test covers file symlinks in CI.

| Finding | Resolution |
| --- | --- |
| 1 | Shared dirty-aware close handler for mouse, middle-click, Enter, and Space. |
| 2 | Resolve/check the parent and unlink the selected symlink or junction; reject root/traversal deletion. |
| 3 | Reserve explicit sessions before continuation; scope claims per agent and normalized directory. |
| 4 | Allow HTTP(S) frames in CSP; retain the preview host allowlist and sandbox. |
| 5 | Shared NUL-delimited Git porcelain parser handles literal paths and rename/copy records. |
| 6 | Apply stored editor preferences in both modes; auto-save on blur/tab switch, including edits during a pending write. |
| 7 | Check repository membership separately from branch resolution. |
| 8 | Wait for receiver readiness and correlated adoption acknowledgement; timeout/cancellation preserves source tabs and rolls back destination views. |
| 9 | Route windows using saved terminal IDs; migrate only unambiguous legacy identities. |

## Original audit verification

- Frontend: 554 tests passed across 65 files (`npm.cmd run test:run`).
- Rust: 267 tests passed (`cargo test --manifest-path src-tauri/Cargo.toml`).
- Worker: 15 tests passed (`npm.cmd run test:run --prefix workers/ct-analytics`).
- Production frontend build passed (`npm.cmd run build`); it warns about a 5.87 MB minified main JavaScript chunk and ineffective dynamic imports.
- Headless Chromium: booted the actual frontend with mocked Tauri IPC, opened file tabs, checked editor rendering, switched files, and exercised keyboard closing. No startup page errors in that harness.
- Browser policy reproduction used the exact CSP from `src-tauri/tauri.conf.json`.
- Git reproductions used a newly created disposable repository under `.cache`, without touching the project's index or Git configuration.

This was not a full native desktop E2E run: PTY spawning, real agent conversations, OS window transfers, credential stores, native updating, and macOS behavior were not exercised interactively. Mocked IPC does not establish that those integrations work. Findings below distinguish reproduced behavior from source-traced failure paths. Passing tests do not cover these cases.

## 1. High — Keyboard closing silently discards unsaved edits

Location: `src/components/TerminalTabs.tsx:262–265`.

The close control's mouse and middle-click handlers confirm dirty-file discard, but its Enter/Space handler calls `closeFileTab` directly. That removes the file and its unsaved content from the store.

Reproduced in Chromium: open a file, change its content, focus its “Unsaved changes” close control, and press Enter. The tab disappears; no confirmation dialog or write IPC occurs.

Suggested fix: share one dirty-aware close handler across pointer and keyboard activation.

## 2. High — Discarding an untracked symlink deletes its target

Location: `src-tauri/src/commands.rs:5161–5185` (`git_discard_file`).

The untracked-delete branch canonicalizes the selected path, then performs metadata lookup and deletion on that canonical target. An untracked symlink to a tracked file or directory inside the repository passes the containment check. Discarding the link therefore deletes the target file or recursively deletes the target directory, while leaving the link behind. A link to the repository root also passes the current equality-inclusive containment check.

Evidence: source-traced deletion path; destructive behavior was not executed. The UI passes untracked entries to this branch from `ChangelistSection.tsx`.

Suggested fix: inspect links without following them and unlink the selected link itself. Explicitly reject the repository root as a deletion target; preserve containment checks for ordinary entries.

## 3. High — Restore can attach two terminals to one conversation

Location: `src/lib/restorePlan.ts:45–56`; consumed by `src/App.tsx:702–752`.

Session-ID claims and working-directory continuation claims are tracked independently. Given a saved terminal with session ID `newest-session` and an ID-less terminal in the same directory, the planner returns `resume(newest-session)` and `continue`. If that ID is the most recent conversation, both processes attach to it. This violates the planner's explicit isolation invariant.

Reproduced the planner output in the browser against the actual module. Native agent attachment was not run. The existing “mixes id and id-less terminals independently” test currently enshrines this unsafe combination. Deduplication also lacks agent identity, so different agents can unnecessarily consume each other's continuation slots.

Suggested fix: plan per agent and normalized directory; avoid ambiguous continuation whenever another restored terminal might already claim that directory's latest conversation. Resolve exact IDs where possible.

## 4. Medium — Production CSP blocks local app previews

Location: `src-tauri/tauri.conf.json:29`; iframe creation in `src/components/PreviewPanel.tsx:154–180`.

The policy has `default-src 'self'` without a `frame-src` directive. Preview's JavaScript allowlist accepts localhost and configured external hosts, but the browser policy independently rejects their iframe navigation.

Reproduced in Chromium using the exact configured policy and an iframe targeting `http://localhost:3000`: “Framing ... violates ... default-src 'self' ... The request has been blocked.” This policy-level reproduction did not require a running target server.

Suggested fix: define a frame policy compatible with the intended preview destinations while retaining the application allowlist and appropriate iframe restrictions.

## 5. Medium — Git filenames with spaces or non-ASCII characters break file actions

Locations: `src-tauri/src/commands.rs:2119–2150` and `4557–4587`.

Both status parsers read line-oriented `git status --porcelain` and treat the path substring as a literal filename. Git quotes paths containing spaces and escapes non-ASCII bytes under its default quote-path behavior. Neither parser decodes that representation. The resulting quoted/escaped string is passed to filesystem and Git actions.

Reproduced with `file with spaces.txt` and `café.txt` in a disposable repository. The parser produced literal quote-wrapped paths; both subsequent `git add -- <parsed-path>` calls failed with exit 128, “pathspec ... did not match any files.”

Suggested fix: use `--porcelain=v1 -z` and parse NUL-delimited records, including rename/copy records, without shell-style string splitting.

## 6. Medium — Editor preferences and auto-save have no effect

Locations: `src/components/FileEditorView.tsx:171–203`; settings in `src/components/settings/categories/EditorGeneralPage.tsx` and `EditorFontPage.tsx`.

The settings pages persist font family/size/line height, tab size, word wrap, whitespace, minimap, and auto-save-on-blur preferences. The file editor uses hardcoded options and does not subscribe to these preferences. No production consumer implements `editorAutoSaveOnBlur`.

Reproduced: set font size to 24 and enable auto-save, then open an editor. Its rendered text remained 13px. Change file A and switch to file B: zero `write_text_file` calls occurred. Other hardcoded options were confirmed by source inspection.

Suggested fix: consume the stored settings in both editor modes and implement dirty-file saves when the relevant editor/tab loses focus, with save-error handling.

## 7. Medium — Fresh Git repositories are treated as non-repositories

Locations: `src-tauri/src/commands.rs:2091–2112` and `4530–4552`.

The changes commands decide whether a directory is a Git repository by whether `git rev-parse --abbrev-ref HEAD` succeeds. That fails before the first commit, so both commands return `is_git_repo: false` before reading status. The changes UI cannot expose the initial files for staging through these commands.

Reproduced after `git init`: the exact branch command exits 128, while `git rev-parse --is-inside-work-tree` returns `true` and status lists the untracked files.

Suggested fix: test repository membership separately and support an unborn HEAD when resolving the branch.

## 8. Medium — Failed tab transfer removes tabs from the source anyway

Locations: `src/lib/tabTransfer.ts:35–62`, `103`, and `143–159`.

`createDetachedWindow` returns after constructing the asynchronous WebviewWindow, before the created/error event. `routeTabDrop` then immediately detaches the source tabs. If creation fails, the error handler only reports the failure and never restores the tabs. Existing-window transfers also detach before the destination confirms adoption; a destination failure leaves the source empty. Restore uses the same premature-detachment pattern.

Evidence: source-traced asynchronous failure paths. Native window-creation failure was not injected. The PTY can remain running in the backend while its source view has disappeared.

Suggested fix: detach only after successful adoption acknowledgement, with bounded waiting and rollback/error feedback for failure.

## 9. Medium — Window restore maps distinct same-directory shells to one terminal

Locations: `src/lib/windowLayout.ts:25–31`; `src/App.tsx:691–720` and `762–769`.

The fallback layout identity is only `cwd:<working_directory>`. Two shells in the same directory therefore have identical keys. During restore, assignment to `keyToNewId[stableKey]` overwrites the first restored terminal with the second. Saved detached-window entries for either shell resolve to the last terminal, so the wrong shell moves and multiple windows can adopt the same PTY. ID-less agents in the same directory have the same collision.

Evidence: source-traced identity and mapping flow; native multi-window restore was not run.

Suggested fix: persist a unique terminal identity for layout routing and map each saved terminal ID to its newly restored ID. Keep conversation identity separate from window/tab identity.
