# Send Context to Agents (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five small features as one release: fork a conversation, a per-repo worktree setup command, cleanup when a PR merges or closes, a browser element picker that stages context for the agent, and line comments on diffs that are sent to the agent as one review.

**Architecture:** Each feature extends code that already exists: `resume_flags_for` (fork), `races::run_check` plus the `tasks` registry (setup command), `usePullRequestPoller` / `prTransitions` (PR cleanup), the `browser.rs` `on_navigation` hook (picker), and `InlineDiffView` (review). The browser picker and the diff review both end in one new shared helper, `stageForAgent`, which appends text to the target session's prompt-editor draft and opens the editor. Nothing is ever typed into a PTY or sent automatically.

**Tech Stack:** Tauri 2, Rust (rusqlite, tokio, serde, url, uuid), React 18 + TypeScript, Zustand, Tailwind, Vitest + Testing Library.

**Spec:** No separate spec. The design decisions are in "Design decisions" below. They come from the feature list agreed on 2026-10-30 (Tier 1 of the industry scan). Read that section before any task.

## Design decisions

1. **Fork** is offered only for Claude (`--resume=<id> --fork-session`) and Codex (`codex fork <id>`); both were checked against the CLIs' `--help` on 2026-10-30. Cursor, Antigravity and custom agents have no fork form, so the menu item is disabled for them and Rust refuses `fork: true` for them. A fork runs in the **same working directory** as the source, because Claude looks up sessions by cwd. A forked terminal never persists the source's session id. Session capture fills in the new id.
2. **Setup command** is one shell command per repo (for example `npm ci`). It is stored in a new local-only SQLite table keyed by the main repo root and is never synced. Rust runs only the stored command, in a worktree from the `tasks` table, reusing `races::run_check` (Job Object / process group, timeout, cancel). It runs **after the worktree exists and before any agent terminal is created**. A non-zero exit, a timeout or a cancel **fails closed**: the worktree is rolled back through the existing rollback paths, and the error shows the output tail.
3. **PR cleanup** closes the PR's sessions and, for task sessions, removes the worktree while keeping the branch (`finish_task` `keep`). A session is skipped if its agent is busy or its worktree has uncommitted changes. A worktree is removed only when every session in it is closing. Manual: a "Clean up sessions..." item in the session card menu once the PR is merged or closed. Automatic: opt-in setting, **merged only**. A closed PR may be reopened, so it gets an attention item but never automatic cleanup.
4. **Browser picker**: a toolbar button arms the picker for one tab with a random nonce and injects a script. Clicking an element navigates to `agentrium-pick://pick?n=<nonce>&d=<json>`. Esc navigates to `agentrium-pick://cancel?n=<nonce>`. `on_navigation` intercepts that scheme **before** `nav_decision`, accepts it only for the armed tab with a matching nonce, disarms, emits an event and cancels the navigation. A page can forge a pick only while the picker is armed. The result is only staged in the prompt editor for the user to read, never sent.
5. **Review comments** live in memory (not persisted, not synced), keyed by terminal. "Send review (N)" builds one brief, stages it with `stageForAgent`, and clears the comments.

## Global Constraints

- All work is in the `agentrium/` repo on a new branch `feat/send-context-to-agents` off `master`. Run Rust commands from `agentrium/src-tauri`, frontend commands from `agentrium/`.
- Sources use CRLF line endings: prefer the Edit tool, and never do multi-line `sed` replacements.
- Never use an em-dash or en-dash character anywhere (code, comments, copy, commit messages, changelog). Use a plain hyphen.
- Every `#[command]` body is wrapped in `wrap_cmd("<name>", ...)`; user/environment errors use `error_reporter::user_err(...)`. Register every new command in `main.rs`'s `invoke_handler`.
- Frontend errors: user-initiated failure = `toast.error(...)` + `reportInvokeFailure('<command>', err)`; background best-effort = `.catch(() => {})` with a one-line comment. Never `console.error` only.
- Never write prompt text into a PTY. Context reaches an agent only through `setPromptDraft` / `openPromptEditor`.
- No new colors: use existing tokens (see `FileChangesPanel.tsx`, `SessionCards.tsx`).
- No change to `agentrium-api` or the sync protocol. The new table and stores are local only: never call `enqueue_sync` / `touch_sync_row` for them.
- Tauri arg names: Rust `worktree_path` / `run_id` / `repo_path` are passed from JS as `worktreePath` / `runId` / `repoPath`.

## Review Focus

1. **Picker on a page that navigates or reloads while armed:** the injected script is gone, so the picker would never report back. The UI must disarm on `loadStarted` for that tab and call `browser_cancel_pick`. Test in Task 4 (`disarms picker when the tab starts loading`).
2. **A forged pick URL from a page that is not armed, or with a wrong nonce:** it must be cancelled (no navigation, no external protocol launch) and emit nothing. Test in Task 4 (`pick_url_without_armed_nonce_is_dropped`).
3. **Setup command that hangs or the user cancels:** the whole process tree is killed, the worktree is rolled back, and the modal returns to idle. Tests in Task 2 (`run_task_setup_reports_timeout`, `launchTask rolls back when setup fails`).
4. **PR cleanup with two sessions in one task worktree, one busy:** the idle one closes, the worktree is kept, and the report names the busy one. Test in Task 3 (`keeps a worktree while any of its sessions is skipped`).
5. **Diff changes after a comment was written (the agent edited the file):** the comment still appears in the send bar and in the brief with its quoted snippet, even when its line no longer exists in the diff. Test in Task 5 (`brief keeps comments whose line left the diff`).

---

### Task 1: Fork a conversation

**Files:**
- Modify: `src-tauri/src/terminal.rs` (`resume_flags_for` at ~255, `create_terminal` at ~415-475 and the persisted `claude_session_id` at ~643, tests at ~1505)
- Modify: `src-tauri/src/commands.rs` (`CreateTerminalRequest` at ~389, the `create_terminal` call into the manager)
- Modify: `src/store/terminalStore.ts` (`CreateTerminalOptions` at ~137, request body at ~290)
- Create: `src/lib/fork.ts`, `src/lib/fork.test.ts`
- Modify: `src/components/SessionCards.tsx` (context menu at ~430), `src/lib/paletteSources.ts` (session actions)

**Interfaces:**
- Produces (Rust): `pub(crate) fn supports_fork(kind: &AgentKind) -> bool`; `resume_flags_for(spec, resume_id, continue_recent, fork: bool) -> ResumeInjection`; `CreateTerminalRequest.fork: bool` (`#[serde(default)]`).
- Produces (TS): `CreateTerminalOptions.fork?: boolean`; `canFork(t: TerminalInstance): boolean`; `forkSession(sourceId: string): Promise<string>` (returns the new terminal id).

- [ ] **Step 1: Write the failing Rust tests** in `terminal.rs`'s test module:

```rust
#[test]
fn fork_for_claude_adds_fork_session() {
    let out = super::resume_flags_for(&builtin_spec(&AgentKind::Claude).unwrap(), Some("abc"), false, true);
    assert_eq!(out.leading, vec!["--resume=abc".to_string(), "--fork-session".to_string()]);
    assert!(out.subcommand.is_none());
}
#[test]
fn fork_for_codex_uses_fork_subcommand() {
    let out = super::resume_flags_for(&builtin_spec(&AgentKind::Codex).unwrap(), Some("s-9"), false, true);
    assert_eq!(out.subcommand.as_deref(), Some("fork"));
    assert_eq!(out.leading, vec!["s-9".to_string()]);
}
#[test]
fn supports_fork_only_claude_and_codex() {
    assert!(super::supports_fork(&AgentKind::Claude));
    assert!(super::supports_fork(&AgentKind::Codex));
    assert!(!super::supports_fork(&AgentKind::Cursor));
    assert!(!super::supports_fork(&AgentKind::Antigravity));
    assert!(!super::supports_fork(&AgentKind::Custom("x".into())));
}
```

Update every existing `resume_flags_for(...)` test call to pass `false` as the new last argument.

- [ ] **Step 2: Run** `cargo test resume_flags_for fork supports_fork`. Expected: compile error (arity and missing fn).

- [ ] **Step 3: Implement.** Add the `fork` parameter. When `fork` and `resume_id` is `Some`, Claude gets `leading = ["--resume=<id>", "--fork-session"]` and Codex gets `subcommand = "fork", leading = [id]`; all other arms are unchanged. Add `supports_fork`. Add `fork: bool` to `TerminalManager::create_terminal`. Before the injection, if `fork` is set and either the resume id is missing or `!supports_fork(&spec.kind)`, return `user_err("This agent can't fork a conversation.")`. Persist `claude_session_id: if fork { None } else { resume_session_id }`. Add `#[serde(default)] pub fork: bool` to `CreateTerminalRequest` and pass it through.

- [ ] **Step 4: Run** `cargo test`. Expected: PASS.

- [ ] **Step 5: Write the failing TS tests** in `src/lib/fork.test.ts` (mock `invoke` the same way `handoff.test.ts` does):
  - `canFork` is true for a `claude` or `codex` terminal with `claude_session_id: 'abc'`, false with no session id, and false for `cursor` even with an id.
  - `forkSession('t1')` calls `create_terminal` with `working_directory` equal to the source's, `claude_args` equal to the source's `claude_args`, `resume_session_id: 'abc'`, `fork: true`, the same `agent`, `credential_bindings` and `task`, and `label` `Fork: <sessionDisplayName(source)>`.
  - `forkSession` rejects with `'The source session is no longer open.'` for an unknown id, and with `"This agent can't fork a conversation."` when `canFork` is false.

- [ ] **Step 6: Run** `npx vitest run src/lib/fork.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 7: Implement** `src/lib/fork.ts` and add `fork: !!options?.fork` to the `create_terminal` request in `terminalStore.ts`. In `SessionCards.tsx`, add a `GitBranch` icon item "Fork conversation" under "Continue with another agent...", disabled when `!canFork`, with a `title` of "Only Claude Code and Codex sessions with a saved conversation can fork". It calls `forkSession` with the user-action error pattern (`toast.error` + `reportInvokeFailure('create_terminal', err)`). Add a palette action "Fork current session" that runs on the active terminal.

- [ ] **Step 8: Run** `npx vitest run src/lib/fork.test.ts src/components/SessionCards.test.tsx && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 9: Commit** `feat: fork a Claude or Codex conversation into a new session`.

---

### Task 2: Per-repo worktree setup command

**Files:**
- Modify: `src-tauri/src/database.rs` (new `migrate_task_setup`, called next to `migrate_races` at ~391; two methods)
- Modify: `src-tauri/src/races.rs` (make `running_checks` and `CheckGuard` `pub(crate)`; extract `pub(crate) fn cancel_check(run_id: &str) -> bool` from `cancel_race_check`)
- Modify: `src-tauri/src/tasks.rs` (three commands), `src-tauri/src/main.rs` (register)
- Create: `src/lib/taskSetup.ts`, `src/lib/taskSetup.test.ts`
- Modify: `src/lib/tasks.ts` (`launchTask`), `src/lib/races.ts` (race launch at ~570), `src/components/settings/categories/GitPage.tsx` (row below `SetupFilesRow`), `src/components/NewTaskModal.tsx`, `src/components/NewRaceModal.tsx`

**Interfaces:**
- Produces (Rust DB): table `task_setup_commands(repo_path TEXT PRIMARY KEY, command TEXT NOT NULL, updated_at TEXT NOT NULL)`; `Database::get_task_setup_command(&self, repo_path: &str) -> Result<Option<String>, String>`; `Database::set_task_setup_command(&self, repo_path: &str, command: Option<&str>) -> Result<(), String>` (`None` deletes the row).
- Produces (commands): `get_task_setup_command(repo_path: String) -> Option<String>`; `set_task_setup_command(repo_path: String, command: Option<String>) -> ()`; `run_task_setup(worktree_path: String, run_id: String, timeout_secs: Option<u64>) -> Option<RaceCheckResult>` (`None` = no command configured); `cancel_task_setup(run_id: String) -> bool`.
- Produces (TS): `getTaskSetupCommand(repoPath: string): Promise<string | null>`; `setTaskSetupCommand(repoPath: string, command: string | null): Promise<void>`; `runTaskSetup(worktreePath: string, runId: string): Promise<RaceCheckResult | null>`; `cancelTaskSetup(runId: string): Promise<boolean>`; `setupFailed(r: RaceCheckResult): boolean`; `setupFailureMessage(r: RaceCheckResult): string`. `LaunchTaskParams` gains `setupRunId?: string` and `onPhase?: (phase: 'worktree' | 'setup' | 'agent') => void`; the race launch params gain the same two fields.

- [ ] **Step 1: Write failing Rust tests.** In `database.rs`: `task_setup_command_round_trip` (set, get, set `None`, get returns `None`; setting twice keeps one row). In `tasks.rs` (a temp git repo, as in the existing `start_task_impl` tests): `run_task_setup_runs_in_worktree` (command `echo ok > setup.txt` creates the file in the worktree, not in the repo, with `exit_code == Some(0)`); `run_task_setup_reports_timeout` (a sleeping command with a 5 s timeout gives `timed_out == true`, `exit_code == None`); `run_task_setup_refuses_unregistered_worktree` (an unknown path returns `Err("This worktree is not a task managed by Agentrium.")`). Put the core in `async fn run_task_setup_impl(command: Option<String>, task: &TaskInfo, run_id: &str, timeout: Duration) -> Result<Option<RaceCheckResult>, String>` so tests avoid Tauri `State`.

- [ ] **Step 2: Run** `cargo test task_setup`. Expected: FAIL.

- [ ] **Step 3: Implement.** The key is `main_repo_root(repo_path)` as a string, so a task's `repo_path` and the settings page's repo match. `set_task_setup_command` trims, turns empty into `None`, and validates with `races::validate_check_command`. `run_task_setup` resolves `registered_task`, then the stored command for its `repo_path`, then registers `run_id` in `running_checks` (rejecting a duplicate `run_id` with `user_err("That setup is already running.")`), then calls `races::run_check` in the worktree with `timeout_secs.unwrap_or(DEFAULT_CHECK_TIMEOUT_SECS).clamp(5, MAX_CHECK_TIMEOUT_SECS)`. `cancel_task_setup` and `cancel_race_check` both call `cancel_check`.

- [ ] **Step 4: Run** `cargo test`. Expected: PASS.

- [ ] **Step 5: Write failing TS tests** in `src/lib/taskSetup.test.ts` and `src/lib/tasks.test.ts`:
  - `setupFailed` is false only for `exit_code === 0` with `!timed_out && !cancelled`.
  - `setupFailureMessage` returns `'Setup command timed out.'`, `'Setup was cancelled.'`, or `'Setup command failed (exit 2).'` + `'\n\n' + output_tail.slice(-2000)`.
  - `launchTask rolls back when setup fails`: `run_task_setup` resolves with `exit_code: 1`, so `finish_task` is invoked with `{ kind: 'discard', confirm_unmerged: false }`, `create_terminal` is never invoked, and the promise rejects with the failure message.
  - `launchTask skips setup when none is configured`: `run_task_setup` resolves `null` and `create_terminal` is invoked.
  - `onPhase` is called in the order `'worktree'`, `'setup'`, `'agent'`.

- [ ] **Step 6: Run** `npx vitest run src/lib/taskSetup.test.ts src/lib/tasks.test.ts`. Expected: FAIL.

- [ ] **Step 7: Implement.** In `launchTask`, after `startTask`, call `runTaskSetup(task.worktreePath, p.setupRunId ?? crypto.randomUUID())`. On failure, use the same discard rollback as the existing `catch`, then throw `new Error(setupFailureMessage(r))`. In the race launch, after `start_race`, run every contender's setup in parallel (`Promise.all`). If any fails, call `cancelTaskSetup` on the rest, then `abandonRace` with the existing rollback arguments, then throw. `NewTaskModal` and `NewRaceModal` pass `onPhase`, show "Running setup..." with a Cancel button while the phase is `'setup'`, and Cancel calls `cancelTaskSetup(runId)`. In `GitPage.tsx`, add a "Setup command" text field for the selected repo, saved on blur via `setTaskSetupCommand`, with the description: "Runs in every new task or race worktree before the agent starts, for example npm ci. If it fails, the new worktree is removed."

- [ ] **Step 8: Run** `npm run test:run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 9: Commit** `feat: run a per-repo setup command in new task worktrees`.

---

### Task 3: Clean up sessions when a PR merges or closes

**Files:**
- Modify: `src/lib/pullRequests.ts` (`PrEvent`, `prTransitions` at ~142), `src/lib/pullRequests.test.ts`
- Modify: `src/store/attentionStore.ts` (`AttentionKind` gains `'closed'`; `channelOf` maps it to `'pr'`)
- Modify: `src/hooks/usePullRequestPoller.ts` (`eventCopy`, auto-cleanup on merged)
- Create: `src/lib/prCleanup.ts`, `src/lib/prCleanup.test.ts`
- Modify: `src/store/appStore.ts` (persisted `autoCleanupMergedPrs: boolean`, default `false`, plus setter), `src/components/settings/categories/GitPage.tsx` (toggle), `src/components/SessionCards.tsx` (menu item)

**Interfaces:**
- Consumes: `terminalPrTarget(id)` (`lib/pullRequestActions.ts`), `getTaskStatus(worktreePath)` (`lib/tasks.ts`), `useTerminalStore.closeTerminal`, `invoke('finish_task', { worktreePath, action: { kind: 'keep' } })`.
- Produces: `PrEvent` gains `{ kind: 'closed'; status }`; `interface CleanupCandidate { terminalId: string; busy: boolean; worktreePath: string | null; uncommitted: number }`; `interface CleanupPlan { close: string[]; removeWorktrees: string[]; skipped: { terminalId: string; reason: string }[] }`; `planCleanup(c: CleanupCandidate[]): CleanupPlan`; `cleanUpPrSessions(prKey: string): Promise<CleanupPlan>`.

- [ ] **Step 1: Write failing tests.** `pullRequests.test.ts`: `open -> closed` yields `[{ kind: 'closed' }]`; `closed -> closed` yields `[]`; `open -> merged` still yields only `merged`. `prCleanup.test.ts`:
  - A busy candidate is skipped with reason `'Agent is still working'`.
  - A candidate with `uncommitted: 3` is skipped with reason `'Uncommitted changes in the worktree'`, and its worktree is not in `removeWorktrees`.
  - `keeps a worktree while any of its sessions is skipped`: two candidates share `/wt/a`, one busy, so `close` has the idle one and `removeWorktrees` is empty.
  - Two idle candidates sharing `/wt/a`: both close, and `removeWorktrees` is `['/wt/a']` once.
  - A candidate with `worktreePath: null` closes and adds nothing to `removeWorktrees`.
  - `cleanUpPrSessions` closes the terminals **before** invoking `finish_task` with `{ kind: 'keep' }` (the Windows cwd lock), and dismisses the `'pr'` attention channel for each closed terminal.

- [ ] **Step 2: Run** `npx vitest run src/lib/prCleanup.test.ts src/lib/pullRequests.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `planCleanup` is pure. `cleanUpPrSessions` builds candidates from the open terminals whose `terminalPrTarget(id)?.key === prKey`: `busy` is `terminalStates.get(id) === 'busy'`, and `uncommitted` comes from `getTaskStatus` for task terminals (0 when not a task). It then closes and finishes per the plan. A `finish_task` failure is reported via `reportInvokeFailure` and recorded in `skipped`; it does not throw. `eventCopy` for `closed`: title `PR #<n> closed`, detail `<branch> was closed without merging. You can clean up its sessions from the session menu.` In the poller, after putting a `merged` attention item, if `autoCleanupMergedPrs` is set, call `cleanUpPrSessions(key)` and show `toast.info` with `Cleaned up N session(s) for PR #<n>` plus `, kept M` when anything was skipped. In `SessionCards`, show "Clean up sessions..." when `prStatuses[target.key]?.state` is `'merged'` or `'closed'`; it runs `cleanUpPrSessions` and shows the same toast. Add a GitPage toggle "Clean up sessions automatically when their PR merges" with `registerSetting` keywords `['pr', 'merge', 'archive', 'cleanup', 'worktree']`.

- [ ] **Step 4: Run** `npm run test:run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: clean up sessions and worktrees when a PR merges or closes`.

---

### Task 4: Browser element picker

**Files:**
- Create: `src-tauri/src/browser_picker.js` (injected script, `__NONCE__` placeholder)
- Modify: `src-tauri/src/browser.rs` (`BrowserEvent` at ~39, `create_tab` `on_navigation` at ~174, new commands, tests), `src-tauri/src/main.rs`
- Create: `src/lib/agentContext.ts`, `src/lib/agentContext.test.ts`, `src/lib/browser/pickedElement.ts`, `src/lib/browser/pickedElement.test.ts`
- Modify: `src/lib/browser/controller.ts` (`handleEvent` at ~53, `BrowserEventPayload`), `src/store/browserStore.ts` (`pickingTabId: string | null`), `src/components/browser/BrowserView.tsx` (toolbar button next to Reload)

**Interfaces:**
- Produces (Rust): `pub struct PickedElement { url: String, title: String, selector: String, tag: String, text: String, html: String }` (Serialize + Deserialize, camelCase); `BrowserEvent::ElementPicked { id, element: PickedElement }` and `BrowserEvent::PickCancelled { id }`; `pub fn parse_pick_url(u: &Url, armed_nonce: Option<&str>) -> PickOutcome` with `pub enum PickOutcome { NotPick, Picked(PickedElement), Cancelled, Rejected }`; commands `browser_pick_element(id: String) -> ()` and `browser_cancel_pick(id: String) -> ()`.
- Produces (TS, shared with Task 5): `stageForAgent(terminalId: string, block: string): void`; `stageTarget(): string | null` (the active terminal id when it is an agent session, not a shell or script tab).
- Produces (TS): `formatPickedElement(e: PickedElement): string`.

- [ ] **Step 1: Spike (no commit).** In `npm run tauri dev` on Windows, temporarily inject `location.href = 'agentrium-pick://cancel?n=x'` from a test command and confirm `on_navigation` sees the URL and returning `false` stops the navigation with no external-protocol prompt. If WebView2 does not raise it, switch the channel to `on_document_title_changed` with title `agentrium-pick:<nonce>:<json>`, restoring the old title in the script, and keep everything else in this task the same. Record the result in the commit message of Step 9.

- [ ] **Step 2: Write failing Rust tests** in `browser.rs`:
  - `pick_url_without_armed_nonce_is_dropped`: `parse_pick_url(&u("agentrium-pick://pick?n=abc&d=%7B%7D"), None)` is `Rejected`; the same URL with `Some("zzz")` is `Rejected`.
  - `pick_url_parses_and_truncates`: a valid payload with `Some("abc")` gives `Picked`, with `text` capped at 500 chars, `html` at 4000, and `selector` at 500 (char boundaries, no panic on multi-byte input).
  - `pick_cancel_url`: `agentrium-pick://cancel?n=abc` with `Some("abc")` gives `Cancelled`.
  - `non_pick_url_is_not_pick`: `https://example.com` gives `NotPick`.
  - `oversized_pick_payload_is_rejected`: a `d` longer than 32 KiB gives `Rejected`.
  - Extend `events_serialize_with_camel_case_kind` so `ElementPicked` serializes as `"kind":"elementPicked"`.

- [ ] **Step 3: Run** `cargo test pick`. Expected: FAIL.

- [ ] **Step 4: Implement Rust.** Keep a `static ARMED: OnceLock<Mutex<HashMap<String, String>>>` from tab id to nonce. In `on_navigation`, check `u.scheme() == "agentrium-pick"` **before** `nav_decision`. Remove the tab's nonce, call `parse_pick_url`, emit `ElementPicked` or `PickCancelled` (nothing for `Rejected`), and always return `false`. `browser_pick_element` runs `validate_id`, creates `uuid::Uuid::new_v4().simple()` as the nonce, stores it, and calls `eval` on `include_str!("browser_picker.js").replace("__NONCE__", &nonce)`. `browser_cancel_pick` removes the nonce and calls `eval("window.__agentriumPick && window.__agentriumPick.cancel()")`. `browser_close` also removes the tab's nonce. In `browser_picker.js`: a fixed-position highlight box that follows `mousemove`; capture-phase `click` with `preventDefault` + `stopPropagation`; `Esc` cancels. The selector is `#id` when the id is unique in the document; otherwise a `tag:nth-of-type(n)` chain up to the first ancestor with a unique id, at most 6 levels. Truncate `html` until the encoded URL is 32 KiB or less. Remove the listeners and the box before navigating.

- [ ] **Step 5: Run** `cargo test`. Expected: PASS.

- [ ] **Step 6: Write failing TS tests.**
  - `agentContext.test.ts`: `stageForAgent('t1', 'B')` with an existing draft `'A'` sets the draft to `'A\n\nB'` and calls `openPromptEditor('t1', 'A\n\nB')`; with an empty draft it sets `'B'`. `stageTarget()` returns `null` when the active terminal is a shell terminal (`isShellTerminal`) or a script tab (`scriptName` set).
  - `pickedElement.test.ts`: `formatPickedElement` output starts with `## Page element` and contains `URL: <url>`, ``Selector: `<selector>` ``, the text, and the HTML inside a fenced `html` block. It contains no template placeholders when `text` is empty.
  - Controller test: `elementPicked` for the picking tab clears `pickingTabId` and calls `stageForAgent` with the formatted block. With no `stageTarget()`, it shows a toast (`'Open an agent session to send this element to.'`) and copies the block with `copyText`. `disarms picker when the tab starts loading`: `loadStarted` for the picking tab clears `pickingTabId` and invokes `browser_cancel_pick`.

- [ ] **Step 7: Run** `npx vitest run src/lib/agentContext.test.ts src/lib/browser`. Expected: FAIL.

- [ ] **Step 8: Implement TS.** Add a `Crosshair` toolbar button (`aria-label` "Pick an element to send to the agent", pressed state while `pickingTabId === tab.id`). Clicking it again or pressing Esc in the app calls `browser_cancel_pick`. Show a one-line notice under the toolbar while armed: "Click an element on the page. Esc cancels."

- [ ] **Step 9: Run** `npm run test:run && npx tsc --noEmit && (cd src-tauri && cargo clippy)`. Manual check in `/qa`: pick a button on a real page, confirm the prompt editor opens on the split terminal with the block. Commit `feat: pick a page element in the built-in browser and stage it for the agent`.

---

### Task 5: Review comments on diffs

**Files:**
- Create: `src/store/reviewStore.ts`, `src/store/reviewStore.test.ts`, `src/lib/review.ts`, `src/lib/review.test.ts`
- Modify: `src/components/InlineDiffView.tsx` (gutter button, inline editor, rendered comments), `src/components/ChangelistSection.tsx` (send bar above the file list)
- Test: `src/components/InlineDiffView.test.tsx` (new)

**Interfaces:**
- Consumes: `stageForAgent` (Task 4), `DiffHunk` / `DiffLine` (`utils/diffParser.ts`).
- Produces: `interface ReviewComment { id: string; terminalId: string; filePath: string; side: 'new' | 'old'; line: number; snippet: string; body: string }`; store actions `add(c: Omit<ReviewComment, 'id'>): string`, `update(id: string, body: string)`, `remove(id: string)`, `clearFor(terminalId: string)`, selector `commentsFor(terminalId: string): ReviewComment[]`; `buildReviewBrief(comments: ReviewComment[]): string`.

- [ ] **Step 1: Write failing tests.**
  - `reviewStore.test.ts`: add, update and remove round-trip; `clearFor('t1')` leaves `t2`'s comments.
  - `review.test.ts`: the brief starts with `# Review comments` and `Address each comment below, then summarize what you changed.`; groups by file under `## <filePath>` in first-seen order; each item reads ``- Line 42 (new) `<snippet>`: <body>`` (`old` for removed lines). `brief keeps comments whose line left the diff`: the brief includes every comment given, with no lookup against the current diff.
  - `InlineDiffView.test.tsx`: hovering a line shows a button labelled `Comment on line 42`; typing and pressing Ctrl+Enter adds a comment with `snippet` equal to the trimmed line content (cut to 120 chars) and renders it under the line; Esc discards an empty editor.

- [ ] **Step 2: Run** `npx vitest run src/store/reviewStore.test.ts src/lib/review.test.ts src/components/InlineDiffView.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** The store is not persisted. `side` is `'old'` only for `removed` lines (anchored to `oldLineNumber`); every other line uses `newLineNumber`. Render saved comments under the matching `(filePath, side, line)` with a delete button. In `ChangelistSection`, when `commentsFor(terminalId).length > 0`, show a bar: `N review comment(s)`, a primary "Send review" button (`stageForAgent(terminalId, buildReviewBrief(list))` then `clearFor(terminalId)`) and a "Discard" ghost button.

- [ ] **Step 4: Run** `npm run test:run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: comment on diff lines and send the review to the agent`.

---

### Task 6: Docs and full verification

**Files:**
- Modify: `CLAUDE.md` (IPC list: `run_task_setup` / `cancel_task_setup` / `get_task_setup_command` / `set_task_setup_command`, `browser_pick_element` / `browser_cancel_pick`; one sentence each on fork's same-cwd rule and the picker's nonce rule)
- Modify: `README.md` (a short "Send context to agents" section covering fork, setup command, PR cleanup, element picker, review comments)

- [ ] **Step 1: Write the docs.** Keep the README copy free of em-dashes (the website content-lint also reads the desktop changelog at release time).
- [ ] **Step 2: Run the full suite:** `npm run test:run && npx tsc --noEmit && (cd src-tauri && cargo test --locked && cargo clippy && cargo fmt --check)`. Expected: all PASS, no clippy warnings in the touched files.
- [ ] **Step 3: Manual QA** with the `/qa` skill (never the user's running client): fork a Claude session; set `npm ci` as a repo's setup command and start a 2-contender race; pick an element in the browser; comment on two diff lines and send the review; mark a test PR merged with auto-cleanup on.
- [ ] **Step 4: Commit** `docs: document send-context features`.
