# AI Factory (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can add a factory from a Markdown file in a repo, start runs, have stations run as agent sessions, answer human gates in the app, and watch every run on a factory floor.

**Architecture:** The definition (`<stem>.factory.json`) is parsed and linted in Rust. A pure Rust state machine (`apply(run, event, line_busy) -> Action`) owns every run transition and is persisted in SQLite; the frontend only performs the actions that need a terminal (open or close a session) and reports back. Gates are answered through one IPC command called only from the gate dialog. UI follows Race mode: a store with a tracking subscription, a main-area tab, sidebar groups, modals mounted in `App.tsx`.

**Tech Stack:** Rust (Tauri 2, rusqlite, tokio, serde), React 18 + TypeScript, Zustand, Tailwind, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-19-ai-factory-design.md` (read it first). Visual reference, throwaway: `.superpowers/brainstorm/67820-1795076675/content/factory-sketch.html` and `sidebar-layout.html`.

## Global Constraints

- Work on branch `feat/ai-factory` created from `master`. Never commit to `master`.
- Read `CLAUDE.md` in this repo before editing. Its error-handling rules apply to every task.
- Never use an em-dash or en-dash anywhere (code, comments, copy, commit messages). Use a hyphen, comma, colon or parentheses.
- Every `#[command]` body is wrapped in `wrap_cmd("<fn name>", async move { ... }).await`. DB access goes through `db_op(&state.db, move |db| ...)`.
- Errors caused by user input or environment (validation, missing file, wrong run state, unsafe input) are returned with `error_reporter::user_err(...)`. A failed check is data, never an error.
- Frontend, user-initiated action: `.catch(err => { toast.error(...); reportInvokeFailure('<command_name>', err); })`. Background poller: `.catch(() => {})` with a one-line comment saying why.
- Never write a prompt into a PTY. Prompts go through `createTerminal(..., { initialPrompt })`; if `needsStaging(config.prompt_delivery)` is true, call `useAppStore.getState().setPromptDraft(id, prompt)`.
- Factories and runs are local only. Do not touch `sync_client.rs` or any sync row.
- All factory UI, the shortcut and the tracking subscription are gated on `factoryEnabled` (default `false`).
- A check command only ever runs from the definition stored in SQLite (`factory_runs.definition_json`), never from a string sent by the renderer.
- Violet `var(--attention-input)` is the only colour for "needs you". Factory hue is `--nav-factory`: `#38bdf8` dark, `#0284c7` light.
- Limits, verbatim from the spec: step id `^[A-Za-z0-9_-]{1,16}$`; `loop_cap` default 3; `check.timeout_sec` default 300, max 3600; check output kept: last 4000 chars; safe input `^[A-Za-z0-9._:/#@-]{1,200}$`; definition `version` must be 1.
- Rust tests: `cd src-tauri && cargo test --locked <filter>`. Frontend: `npx vitest run <file>` and `npx tsc --noEmit` from the repo root.
- Wire formats: `Definition` and everything inside it is snake_case (it is the file format). `Factory`, `FactoryRun`, `RunStep` are camelCase like `Race`. Tauri command arguments are camelCase on the TS side (`{ runId }`).

## Review Focus

1. **App closed while a check was running.** On restart the run is `checking` with no process. Expected: the run shows "Continue" and resumes the same station without counting an attempt. Pinned in Task 2 (`resume_from_checking_restarts_the_station_without_counting`).
2. **Input with shell characters and a check that uses `{input}`.** Expected: starting the run is refused with a readable message, nothing is spawned. Pinned in Task 5 (`start_refuses_unsafe_input_when_a_check_uses_it`).
3. **Definition file hand-edited into invalid JSON after the factory was added.** Expected: the factory list still loads, the factory shows "Definition changed on disk", runs keep using the stored copy. Pinned in Task 4 (`disk_state_is_changed_for_unparsable_file`).
4. **User closes a station session by hand.** Expected: nothing advances, nothing loops, the row shows "Continue". Pinned in Task 7 (`a run whose terminal is gone is not evaluated`).
5. **Turn-finished detection and a "Check now" click land together.** Expected: one check runs, the second call is refused with a user error and changes nothing. Pinned in Task 5 (`evaluate_refuses_a_run_that_is_already_checking`).

## File Structure

Rust (`src-tauri/src/`):
- `factory_def.rs` (new): definition types, parse, lint, prompt and check rendering. No IO.
- `factory_engine.rs` (new): `RunStatus`, `FactoryRun`, `RunEvent`, `Action`, `apply`. No IO.
- `factory.rs` (new): `Factory`, filesystem helpers, `*_impl` functions, all `#[command]`s.
- `database.rs` (modify): `migrate_factories`, factory and run CRUD.
- `main.rs` (modify): three `mod` lines, handler registration.

Frontend (`src/`):
- `lib/factory.ts` (new): types, IPC wrappers, pure helpers.
- `lib/factoryActions.ts` (new): `performStep`, `kickQueue`, `launchImportSession`.
- `store/factoryStore.ts` (new): state, actions, `subscribeFactoryTracking`.
- `components/FactoryFloor.tsx`, `FactoryGateDialog.tsx`, `AddFactoryModal.tsx`, `NewFactoryRunModal.tsx`, `FactoryNavigator.tsx`, `FactorySidebarGroups.tsx` (new).
- `store/appStore.ts`, `components/Sidebar.tsx`, `components/TerminalTabs.tsx`, `components/SettingsModal.tsx`, `App.tsx`, `hooks/useKeyboardShortcuts.ts`, `index.css`, `lib/lsp/lspClient.ts` (modify).

---

### Task 1: Definition types, lint and rendering

**Files:**
- Create: `src-tauri/src/factory_def.rs`
- Modify: `src-tauri/src/main.rs` (add `mod factory_def;` next to `mod races;`)

**Interfaces:**
- Consumes: `crate::config::AgentKind` (has `Default`, serde), `crate::races::validate_check_command(command: &str) -> Result<(), String>`.
- Produces:

```rust
pub const DEFINITION_VERSION: u32 = 1;
pub const DEFAULT_LOOP_CAP: u32 = 3;
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 300;
pub const MAX_CHECK_TIMEOUT_SECS: u64 = 3600;
pub const CHECK_OUTPUT_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    pub version: u32,
    pub name: String,
    pub source: String,
    #[serde(default)] pub source_sha256: String,
    pub input: InputSpec,
    #[serde(default)] pub workspace: Workspace,
    #[serde(default)] pub agent: AgentKind,
    #[serde(default)] pub rules: Vec<String>,
    pub steps: Vec<Step>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputSpec { pub label: String, #[serde(default)] pub placeholder: String }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Workspace { #[default] Worktree, InPlace }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step { Station(Station), Gate(Gate) }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String, pub name: String, pub prompt: String,
    #[serde(default)] pub artifact: Option<String>,
    #[serde(default)] pub check: Option<Check>,
    #[serde(default)] pub loop_cap: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check { pub command: String, #[serde(default)] pub timeout_sec: Option<u64> }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gate {
    pub id: String, pub name: String, pub question: String,
    pub pass_label: String, pub reject_label: String,
    #[serde(default)] pub show: Vec<String>,
    #[serde(default)] pub notes: Vec<String>,
    pub on_reject: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Lint { pub errors: Vec<LintItem>, pub warnings: Vec<LintItem> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LintItem { pub step_id: Option<String>, pub message: String }

impl Step { pub fn id(&self) -> &str; pub fn name(&self) -> &str; }
impl Station { pub fn cap(&self) -> u32; pub fn timeout_secs(&self) -> u64; } // defaults applied, timeout clamped to 5..=3600
impl Definition {
    pub fn index_of(&self, step_id: &str) -> Option<usize>;
    pub fn station(&self, step_id: &str) -> Option<&Station>;
    pub fn gate(&self, step_id: &str) -> Option<&Gate>;
    pub fn uses_input_in_check(&self) -> bool; // any check.command contains "{input}"
}
pub fn parse_definition(json: &str) -> Result<Definition, String>; // serde error text, prefixed "Not a valid factory definition: "
pub fn validate(def: &Definition) -> Lint;
pub fn input_is_safe(input: &str) -> bool;
pub fn is_plain_file_name(name: &str) -> bool; // non-empty, no '/', no '\\', not "." or "..", no ':'
pub struct PromptVars<'a> { pub input: &'a str, pub run_dir: &'a str, pub reject_reason: &'a str, pub check_output: &'a str }
pub fn render_prompt(def: &Definition, station: &Station, vars: &PromptVars) -> String;
pub fn render_check_command(station: &Station, input: &str, run_dir: &str) -> Option<String>;
```

- [ ] **Step 1: Write the failing tests** in `#[cfg(test)] mod tests` at the bottom of `factory_def.rs`. Use one fixture `fn sample() -> Definition` built by `parse_definition` from this JSON. Declare it at module level (not inside `mod tests`) as `#[cfg(test)] pub(crate) const SAMPLE: &str`, because Tasks 2, 3 and 5 reuse it as `crate::factory_def::SAMPLE`:

```json
{"version":1,"name":"demo","source":"SKILL.md","input":{"label":"Ticket"},
 "workspace":"in_place","rules":["Never merge a pull request."],
 "steps":[
  {"kind":"station","id":"S1","name":"Plan","prompt":"Plan {input} into {run_dir}. {reject_reason}{check_output}","artifact":"plan.md","check":{"command":"node check.js {input}"}},
  {"kind":"gate","id":"G1","name":"Plan approval","question":"Approve this plan?","pass_label":"Approve","reject_label":"Reject","show":["plan.md"],"on_reject":"S1"},
  {"kind":"station","id":"S2","name":"Build","prompt":"Build it."}
 ]}
```

Tests and assertions:
- `parses_sample_with_defaults`: `workspace == Workspace::InPlace`, `agent == AgentKind::default()`, `steps.len() == 3`, `station("S1").unwrap().cap() == 3`, `timeout_secs() == 300`.
- `parse_rejects_unknown_workspace`: replacing `in_place` with `shared` gives `Err` starting with `"Not a valid factory definition: "`.
- `sample_has_no_errors`: `validate(&sample()).errors.is_empty()`.
- One test per lint error, each asserting exactly one error whose `message` is the string given: version 2 -> `"Unsupported definition version 2. This Agentrium supports version 1."`; empty steps -> `"A factory needs at least one step."`; first step a gate -> `"The first step must be a station."`; duplicate id -> `"Step id S1 is used more than once."`; id `"bad id"` -> `"Step id \"bad id\" must be 1 to 16 letters, digits, - or _."`; `on_reject` naming a later or missing station -> `"Gate G1 sends rejects to S9, which is not an earlier station."`; empty prompt -> `"Station S1 has no prompt."`; empty question, pass_label or reject_label -> `"Gate G1 needs a question and both button labels."`; artifact `"../x.md"` -> `"S1: \"../x.md\" must be a plain file name."` (same message for a `show` entry, with the gate id); a check command refused by `validate_check_command` -> `"S1 check command: <that error text>"`.
- Warnings: station S2 (no check, no artifact) -> warning `step_id == Some("S2")`, message `"Finishes only when you mark it done."`; sample has rules -> warning `step_id == None`, message `"Rules are given to the agent as instructions. Agentrium does not enforce them."`; two gates in a row -> `"Two gates in a row."` on the second; a definition with no gate -> `step_id == None`, `"No human gate: this line runs unattended to the end."`.
- `input_is_safe`: true for `"WGCP-12345"`, `"https://x.atlassian.net/browse/A-1"`, `"feat/a_b#3"`; false for `""`, `"a b"`, `"a;rm"`, `"$(x)"`, `"a\"b"`, a 201-char string.
- `render_prompt_substitutes_and_appends_rules`: with `input "A-1"`, `run_dir "C:\\runs\\r1"`, `reject_reason "fix AC2"`, `check_output ""` the result equals `"Plan A-1 into C:\\runs\\r1. fix AC2\n\nRules for this run:\n- Never merge a pull request."`.
- `render_prompt_without_rules_adds_nothing`: station S2 with `rules` cleared renders `"Build it."`.
- `render_check_command`: S1 with input `"A-1"` -> `Some("node check.js A-1")`; S2 -> `None`; `{run_dir}` is substituted raw.

- [ ] **Step 2: Run** `cd src-tauri && cargo test --locked factory_def`. Expected: compile failure (module is empty).

- [ ] **Step 3: Implement** the types and functions exactly as listed under Produces. `validate` collects all errors in step order (it does not stop at the first). `is_plain_file_name` is used for `artifact` and every `show` entry. Placeholder substitution is plain `str::replace`, done once per placeholder in the order `{input}`, `{run_dir}`, `{reject_reason}`, `{check_output}`.

- [ ] **Step 4: Run** `cd src-tauri && cargo test --locked factory_def`. Expected: all pass. Then `cargo clippy --locked -- -D warnings` on the crate: no new warnings (allow `dead_code` on the module with `#![allow(dead_code)]` until Task 4 uses it, and remove that line in Task 5).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/factory_def.rs src-tauri/src/main.rs
git commit -m "feat(factory): definition format, lint and prompt rendering"
```

---

### Task 2: Run state machine

**Files:**
- Create: `src-tauri/src/factory_engine.rs`
- Modify: `src-tauri/src/main.rs` (add `mod factory_engine;`)

**Interfaces:**
- Consumes: Task 1 `Definition`, `Step`, `Workspace`, `Station::cap`, `CHECK_OUTPUT_CHARS`; `crate::error_reporter::user_err`.
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus { Queued, Running, Checking, WaitingGate, Blocked, Done, Cancelled }
impl RunStatus {
    pub fn as_str(self) -> &'static str;      // "queued", "running", "checking", "waiting_gate", "blocked", "done", "cancelled"
    pub fn parse(s: &str) -> Self;            // unknown => Cancelled
    pub fn is_open(self) -> bool;             // everything except Done and Cancelled
    pub fn holds_line(self) -> bool;          // Running | Checking
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryRun {
    pub id: String,
    pub factory_id: String,
    pub input: String,
    pub status: RunStatus,
    pub current_step: String,
    pub attempts: std::collections::BTreeMap<String, u32>,
    pub reject_reason: String,
    pub check_output: String,
    pub definition: Definition,
    pub workspace_path: String,
    pub branch: Option<String>,
    pub run_dir: String,
    pub terminal_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Start, StationPassed, StationFailed { output: String },
    GateApproved { step_id: String }, GateRejected { step_id: String, reason: String },
    Resume, AllowRetry, LineFreed, Cancel,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    StartStation { step_id: String, attempt: u32 },
    AwaitGate { step_id: String },
    Queued, Blocked, Finished, Cancelled,
}
/// `line_busy`: another run of the same factory is Running or Checking.
pub fn apply(run: &mut FactoryRun, event: RunEvent, line_busy: bool) -> Result<Action, String>;
```

Transition rules (the whole algorithm; `enter(step)` is the shared helper):
- `enter(station, count)`: if `definition.workspace == InPlace && line_busy` -> `status = Queued`, `current_step = id`, return `Queued`. Otherwise `status = Running`, `current_step = id`, if `count` then `attempts[id] += 1`, return `StartStation { step_id, attempt: attempts[id] }`.
- `enter(gate)`: `status = WaitingGate`, `current_step = id`, return `AwaitGate`.
- `enter(past the last step)`: `status = Done`, return `Finished`.
- `Start`: only from `Queued` with empty `attempts`; `enter(steps[0], count = true)`.
- `StationPassed`: only from `Running` or `Checking`; clear `check_output` and `reject_reason`; `enter(next step, true)` with `line_busy` forced to `false` when the next step is a station (the run already holds the line).
- `StationFailed { output }`: only from `Running` or `Checking`; `check_output` = last `CHECK_OUTPUT_CHARS` chars of `output` (char boundary safe); if `attempts[current] >= cap` -> `status = Blocked`, return `Blocked`; else `enter(current, true)` with `line_busy = false`.
- `GateApproved { step_id }`: only from `WaitingGate` and `step_id == current_step`; `enter(next, true)` honouring `line_busy`.
- `GateRejected { step_id, reason }`: same guard; `reason.trim()` empty -> `user_err("Give a reason so the agent knows what to change.")`; `reject_reason = reason.trim()`; remove from `attempts` the `on_reject` station and every station after it; `enter(on_reject, true)` honouring `line_busy`.
- `Resume`: only from `Running` or `Checking`; `status = Running`; return `StartStation { step_id: current, attempt: attempts[current] }` (no increment).
- `AllowRetry`: only from `Blocked`; `attempts[current] = cap - 1`; `enter(current, true)` honouring `line_busy`.
- `LineFreed`: only from `Queued` with non-empty `current_step`; `enter(current, true)` honouring `line_busy` (returns `Queued` again if still busy). A `Queued` run that never started (`attempts` empty and `current_step` empty) is handled by `Start`.
- `Cancel`: from any open status; `status = Cancelled`; return `Cancelled`.
- Any event from a status not listed: `user_err("This run is <status label>, so that action does not apply.")` with labels `queued`, `running`, `checking`, `waiting at a gate`, `blocked`, `done`, `cancelled`. A gate event whose `step_id` differs from `current_step`: `user_err("This run is no longer at that gate.")`. No field of `run` changes when an error is returned.

- [ ] **Step 1: Write the failing tests.** Fixture `fn run(def: Definition) -> FactoryRun` with `status: Queued`, empty `attempts`, `current_step: ""`. Build the definition from `crate::factory_def::SAMPLE` (Task 1).

Tests (assert both the returned `Action` and the run fields named):
- `start_enters_first_station`: `Start`, `line_busy false` -> `StartStation { "S1", 1 }`, status `Running`.
- `start_queues_when_in_place_line_is_busy`: `line_busy true` -> `Queued`, status `Queued`, `attempts` empty, `current_step == "S1"`.
- `worktree_runs_ignore_line_busy`: workspace `Worktree`, `line_busy true` -> `StartStation`.
- `line_freed_starts_the_queued_station`: after the queued case, `LineFreed`, `false` -> `StartStation { "S1", 1 }`.
- `pass_moves_to_gate`: -> `AwaitGate { "G1" }`, status `WaitingGate`, `check_output` and `reject_reason` empty.
- `fail_below_cap_retries_same_station_with_output`: `StationFailed { output: "boom" }` -> `StartStation { "S1", 2 }`, `check_output == "boom"`.
- `fail_keeps_only_last_4000_chars`: output of 5000 `'x'` then `"END"` -> `check_output.chars().count() == 4000` and ends with `"END"`.
- `fail_at_cap_blocks`: three failures -> third returns `Blocked`, status `Blocked`, `attempts["S1"] == 3`.
- `allow_retry_gives_exactly_one_more`: from blocked -> `StartStation { "S1", 3 }`; a further failure -> `Blocked`.
- `approve_enters_next_station`: -> `StartStation { "S2", 1 }`.
- `approve_queues_when_line_is_busy`: `line_busy true` -> `Queued`, `current_step == "S2"`.
- `reject_needs_a_reason`: reason `"  "` -> `Err`, status still `WaitingGate`.
- `reject_goes_back_and_resets_attempts`: fail S1 once, pass, then reject with `"fix AC2"` -> `StartStation { "S1", 1 }`, `reject_reason == "fix AC2"`.
- `gate_answer_for_another_gate_is_refused`: `GateApproved { step_id: "G9" }` -> `Err` containing `"no longer at that gate"`.
- `last_station_pass_finishes`: -> `Finished`, status `Done`.
- `resume_from_checking_restarts_the_station_without_counting`: status `Checking`, `attempts["S1"] == 2` -> `StartStation { "S1", 2 }`, status `Running`, attempts unchanged.
- `cancel_from_any_open_status` (loop over the five open statuses) -> `Cancelled`; `cancel_on_done_is_refused`.
- `wrong_state_event_changes_nothing`: `StationPassed` on a `WaitingGate` run -> `Err`, run equals its clone from before.

- [ ] **Step 2: Run** `cd src-tauri && cargo test --locked factory_engine`. Expected: compile failure.
- [ ] **Step 3: Implement** `RunStatus`, `FactoryRun`, `RunEvent`, `Action`, `apply` per the rules above. `apply` must compute on a clone and assign back only on `Ok`, so an error never leaves a half-changed run.
- [ ] **Step 4: Run** `cd src-tauri && cargo test --locked factory_engine`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/factory_engine.rs src-tauri/src/factory_def.rs src-tauri/src/main.rs
git commit -m "feat(factory): pure run state machine"
```

---

### Task 3: Persistence

**Files:**
- Modify: `src-tauri/src/database.rs` (add `migrate_factories`, call it at the end of `init_schema` after `Self::migrate_task_setup(conn)?;`, add the methods below, add tests in the existing `mod tests`)
- Create: `src-tauri/src/factory.rs` containing only the `Factory` and `RunEventRow` structs for now
- Modify: `src-tauri/src/main.rs` (add `mod factory;`)

**Interfaces:**
- Consumes: Task 1 `Definition`, Task 2 `FactoryRun`, `RunStatus`.
- Produces (in `factory.rs`):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Factory {
    pub id: String, pub name: String, pub repo_path: String, pub source_path: String,
    pub definition: Definition, pub created_at: String, pub updated_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRow { pub at: String, pub step_id: String, pub kind: String, pub detail: String }
```

- Produces (on `Database`):

```rust
pub fn upsert_factory(&self, f: &crate::factory::Factory) -> Result<crate::factory::Factory, String>; // keyed on source_path; an existing row keeps its id and created_at; returns the stored row
pub fn get_factory(&self, id: &str) -> Result<Option<crate::factory::Factory>, String>;
pub fn list_factories(&self) -> Result<Vec<crate::factory::Factory>, String>;        // by name, case-insensitive
pub fn delete_factory(&self, id: &str) -> Result<(), String>;                         // runs and events cascade
pub fn insert_factory_run(&self, run: &crate::factory_engine::FactoryRun) -> Result<(), String>;
pub fn update_factory_run(&self, run: &crate::factory_engine::FactoryRun) -> Result<(), String>; // every mutable column, sets updated_at from run.updated_at
pub fn get_factory_run(&self, id: &str) -> Result<Option<crate::factory_engine::FactoryRun>, String>;
pub fn list_factory_runs(&self, limit: u32) -> Result<Vec<crate::factory_engine::FactoryRun>, String>; // newest first
pub fn set_factory_run_terminal(&self, run_id: &str, terminal_id: Option<&str>) -> Result<(), String>;
pub fn factory_line_busy(&self, factory_id: &str, except_run_id: &str) -> Result<bool, String>;  // another run with status running or checking
pub fn factory_has_open_runs(&self, factory_id: &str) -> Result<bool, String>;        // status not done and not cancelled
pub fn oldest_queued_factory_run(&self, factory_id: &str) -> Result<Option<String>, String>;     // run id, by created_at
pub fn insert_factory_run_event(&self, run_id: &str, at: &str, step_id: &str, kind: &str, detail: &str) -> Result<(), String>;
pub fn list_factory_run_events(&self, run_id: &str) -> Result<Vec<crate::factory::RunEventRow>, String>; // oldest first
```

Schema (exact):

```sql
CREATE TABLE IF NOT EXISTS factories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    source_path TEXT NOT NULL UNIQUE,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_runs (
    id TEXT PRIMARY KEY,
    factory_id TEXT NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
    input TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT '',
    attempts_json TEXT NOT NULL DEFAULT '{}',
    reject_reason TEXT NOT NULL DEFAULT '',
    check_output TEXT NOT NULL DEFAULT '',
    definition_json TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    branch TEXT,
    run_dir TEXT NOT NULL,
    terminal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES factory_runs(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_factory_runs_factory ON factory_runs(factory_id);
CREATE INDEX IF NOT EXISTS idx_factory_run_events_run ON factory_run_events(run_id);
```

- [ ] **Step 1: Write the failing tests** in `database.rs` `mod tests`, using `Database::new_in_memory()`, a `fn sample_factory(source_path: &str) -> Factory` and `fn sample_run(id: &str, factory_id: &str, status: RunStatus, created_at: &str) -> FactoryRun` (definition from `crate::factory_def::SAMPLE`):
  - `factories_round_trip`: upsert, `get_factory`, `list_factories` return an equal struct including the nested definition.
  - `upsert_factory_on_same_source_keeps_id`: upsert twice with different `id` and `name`, same `source_path` -> one row, first `id` and `created_at`, second `name`.
  - `factory_runs_round_trip_and_update`: insert, change `status`, `current_step`, `attempts` (`{"S1": 2}`), `reject_reason`, `check_output`, `terminal_id`, `update_factory_run`, `get_factory_run` equals the changed struct.
  - `list_factory_runs_is_newest_first`.
  - `line_busy_ignores_the_asking_run_and_other_factories`: runs A `running` and B `queued` in factory 1, C `running` in factory 2 -> `factory_line_busy("f1", "A") == false`, `("f1", "B") == true`.
  - `oldest_queued_run_is_returned`.
  - `events_are_listed_oldest_first`.
  - `delete_factory_cascades_runs_and_events`.
  - `corrupt_definition_json_is_skipped_in_lists`: write `'not json'` into `factories.definition_json` through `db.conn` -> `list_factories()` is `Ok` and omits that row; same for a run row.
  - Extend the existing `init_schema_is_idempotent` test to also assert the three tables exist.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --locked factor`. Expected: compile failure.
- [ ] **Step 3: Implement** `migrate_factories` and the methods, following `migrate_races`, `RACE_COLUMNS` and `row_to_race`. JSON columns are serialized with `serde_json`.
- [ ] **Step 4: Run** `cd src-tauri && cargo test --locked factor`, then `cargo test --locked init_schema`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/database.rs src-tauri/src/factory.rs src-tauri/src/main.rs
git commit -m "feat(factory): sqlite tables and CRUD for factories and runs"
```

---

### Task 4: Factory management commands (find, review, import, save)

**Files:**
- Modify: `src-tauri/src/factory.rs`
- Modify: `src-tauri/src/main.rs` (register the commands in `generate_handler!` after `races::delete_race`)

**Interfaces:**
- Consumes: Tasks 1 and 3; `crate::commands::{db_op, wrap_cmd}`; `crate::error_reporter::user_err`; `crate::tasks::ensure_repo_trusted(state: &State<'_, AppState>, repo_path: &str) -> Result<(), String>`; the app data dir (same `ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")` that `Database::new` uses).
- Produces:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryCandidate { pub path: String, pub rel_path: String, pub has_definition: bool }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionReview { pub definition: Option<Definition>, pub parse_error: Option<String>, pub lint: Lint }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiskState { Same, Changed, Missing }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryView { #[serde(flatten)] pub factory: Factory, pub disk_state: DiskState }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTicket { pub import_id: String, pub output_path: String, pub prompt: String }

// pure / filesystem helpers (tested directly)
pub fn definition_path_for(source: &Path) -> PathBuf;                 // SKILL.md -> SKILL.factory.json
pub fn find_candidates(repo: &Path) -> Vec<FactoryCandidate>;
pub fn review_json(json: &str) -> DefinitionReview;
pub fn disk_state(stored: &Definition, source: &Path) -> DiskState;
pub fn import_prompt(source: &Path, output: &Path) -> String;
pub fn factory_data_dir() -> Result<PathBuf, String>;                 // <app data>/ , created if missing

// commands
list_factory_candidates(state, repo_path: String) -> Result<Vec<FactoryCandidate>, String>
read_factory_definition_file(state, repo_path: String, source_path: String) -> Result<Option<DefinitionReview>, String> // None when there is no sibling file
begin_factory_import(state, repo_path: String, source_path: String) -> Result<ImportTicket, String>
poll_factory_import(import_id: String) -> Result<Option<DefinitionReview>, String>   // None until the output file exists
save_factory(state, repo_path: String, source_path: String, definition: Definition, write_file: bool) -> Result<FactoryView, String>
list_factories(state) -> Result<Vec<FactoryView>, String>
delete_factory(state, factory_id: String) -> Result<(), String>
```

Decisions:
- `find_candidates` looks in exactly: `<repo>/.claude/skills/*/SKILL.md`; every `.md` under `<repo>/.agentrium/` to depth 4; every `.md` directly in `<repo>` that has a sibling `.factory.json`. Result sorted by `rel_path`, capped at 200, `rel_path` uses forward slashes. Symlinked directories are not followed.
- `review_json`: parse error -> `{ definition: None, parse_error: Some(text), lint: default }`; otherwise `validate`.
- `disk_state`: sibling file missing -> `Missing`; unreadable or unparsable -> `Changed`; parsed definition `!=` stored -> `Changed`; else `Same`.
- Import output path: `<factory_data_dir>/factory-imports/<import_id>.json`. `import_id` is a v4 uuid; `poll_factory_import` refuses any id that is not a uuid with `user_err("Unknown import.")` (prevents path tricks).
- `source_path` must be inside `repo_path` after canonicalisation and end in `.md` (case-insensitive), else `user_err("Pick a Markdown file inside the repo.")`. Every command that takes `repo_path` first calls `ensure_repo_trusted`.
- `save_factory`: `validate`; any error -> `user_err("This definition has errors and cannot be saved: <first message>")`. Sets `definition.source` to the source file name and `definition.source_sha256` to the lowercase hex SHA-256 of the Markdown bytes (use the `sha2` crate if it is already in `Cargo.lock`; if not, add `sha2 = "0.10"` and commit the lock change). When `write_file` is true, write pretty JSON plus a trailing newline to `definition_path_for(source)`. Then `upsert_factory`. Returns the view with `disk_state` recomputed.
- `delete_factory`: refuses with `user_err("This factory still has open runs. Cancel them first.")` when `factory_has_open_runs`. Does not delete any file.
- `import_prompt` returns exactly this text with the two paths substituted:

```text
Read the file at <SOURCE>. It describes a repeatable process as prose. Convert it into an
Agentrium factory definition and write the result as one JSON file at <OUTPUT>. Do not
modify any other file and do not run the process.

The JSON must have this shape:
{
  "version": 1,
  "name": "<short-kebab-name>",
  "source": "<file name of the source>",
  "input": { "label": "<what one run is started with>", "placeholder": "<example>" },
  "workspace": "worktree" | "in_place",
  "rules": ["<each thing the process says must never happen, one sentence each>"],
  "steps": [
    { "kind": "station", "id": "<id>", "name": "<name>", "prompt": "<full instruction for an agent>",
      "artifact": "<file name it must write into the run folder, optional>",
      "check": { "command": "<command whose exit code 0 means the station is done, optional>", "timeout_sec": 300 },
      "loop_cap": 3 },
    { "kind": "gate", "id": "<id>", "name": "<name>", "question": "<what the human is asked>",
      "pass_label": "<button>", "reject_label": "<button>",
      "show": ["<artifact file names the human should read>"],
      "notes": ["<what passing this gate also allows or causes>"],
      "on_reject": "<id of an earlier station to return to>" }
  ]
}

Rules for the conversion:
- Steps are in the order they happen. The first step is a station.
- A step where a human must approve, sign off, or confirm something is a gate. A step the
  source says is detected from another system (for example "wait until merged") is also a
  gate: ask the human whether it has happened.
- Step ids are 1 to 16 characters from letters, digits, "-" and "_". Reuse the source's
  own ids when it has them.
- In a station prompt use {input} for the run's input and {run_dir} for the folder where
  artifacts go. Tell the agent to write its artifact into {run_dir}. Add {reject_reason}
  to a station a gate can send back to, and {check_output} to a station that has a check.
- Use "in_place" when the process switches branches or works across several repositories
  in one folder. Otherwise use "worktree".
- Only add a check when the source names a real command. Never invent one.
- Copy prohibitions into "rules" in the source's own words.
When the file is written, say "Definition written" and stop.
```

- [ ] **Step 1: Write the failing tests** (`#[cfg(test)] mod tests` in `factory.rs`, using `tempfile::tempdir()`):
  - `definition_path_replaces_md`: `a/SKILL.md` -> `a/SKILL.factory.json`; `x.MD` -> `x.factory.json`.
  - `find_candidates_lists_skills_agentrium_and_paired_root_files`: build `.claude/skills/flow/SKILL.md`, `.agentrium/a/b.md`, `README.md` (no sibling), `ROOT.md` + `ROOT.factory.json`, `node_modules/x/SKILL.md` -> rel paths exactly `[".agentrium/a/b.md", ".claude/skills/flow/SKILL.md", "ROOT.md"]`, and only `ROOT.md` has `has_definition == true`.
  - `review_json_reports_parse_error` and `review_json_returns_lint`.
  - `disk_state_same_changed_missing`: write the stored definition -> `Same`; change a prompt -> `Changed`; delete -> `Missing`.
  - `disk_state_is_changed_for_unparsable_file`: write `"{ not json"` -> `Changed`.
  - `import_prompt_contains_both_paths_and_schema`: contains the source path, the output path, `"\"version\": 1"` and `"Definition written"`.
  - `save_impl_sets_source_fields_and_writes_file`: factor the non-`State` part of `save_factory` into `pub(crate) fn prepare_save(repo: &Path, source: &Path, definition: Definition, write_file: bool) -> Result<Definition, String>` and test: `source == "SKILL.md"`, `source_sha256` is 64 hex chars and equals the hash of the bytes, the sibling file exists and parses back equal; with `write_file false` no file is written.
  - `prepare_save_refuses_errors`: empty steps -> `Err` containing `"has errors"`.
  - `prepare_save_refuses_a_source_outside_the_repo` and `..._a_non_markdown_source`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --locked factory::`. Expected: compile failure.
- [ ] **Step 3: Implement** helpers and commands. Commands are thin: trust check, call the helper inside `spawn_blocking` where it touches the filesystem, `db_op` for the database.
- [ ] **Step 4: Run** `cd src-tauri && cargo test --locked factory::` and `cargo check --locked`. Expected: pass, and the seven commands appear in `generate_handler!`.
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/factory.rs src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(factory): find, review, import and save factory definitions"
```

---

### Task 5: Run commands

**Files:**
- Modify: `src-tauri/src/factory.rs`, `src-tauri/src/main.rs` (register), `src-tauri/src/factory_def.rs` (remove the `dead_code` allow)

**Interfaces:**
- Consumes: Tasks 1 to 4; `crate::races::{run_check, running_checks, CheckGuard, cancel_check, RaceCheckResult}` (`run_check(command: &str, cwd: &Path, timeout: Duration, cancel: Arc<Notify>) -> Result<RaceCheckResult, String>`); `crate::tasks::{start_task_impl, StartTaskRequest, TaskInfo}` (`start_task_impl(&StartTaskRequest) -> Result<(StartTaskResult, TaskInfo), String>`); `Database::insert_task(&TaskInfo)`; the id and timestamp helpers `start_race_impl` uses.
- Produces:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepAction {
    #[serde(rename_all = "camelCase")]
    StartStation { step_id: String, step_name: String, attempt: u32, prompt: String, agent: AgentKind, cwd: String, task: Option<TaskInfo> },
    #[serde(rename_all = "camelCase")]
    AwaitGate { step_id: String },
    Queued, Blocked, Finished, Cancelled,
    /// evaluate only: the station is not finished yet
    Waiting,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep { pub run: FactoryRun, pub action: StepAction }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunControl { Resume, AllowRetry, LineFreed, Cancel }

start_factory_run(state, factory_id: String, input: String) -> Result<RunStep, String>
list_factory_runs(state) -> Result<Vec<FactoryRun>, String>                       // limit 500
get_factory_run_events(state, run_id: String) -> Result<Vec<RunEventRow>, String>
set_factory_run_terminal(state, run_id: String, terminal_id: Option<String>) -> Result<(), String>
evaluate_factory_station(state, run_id: String, manual: bool, eval_id: String) -> Result<RunStep, String>
cancel_factory_check(eval_id: String) -> Result<bool, String>
answer_factory_gate(state, run_id: String, step_id: String, approve: bool, reason: Option<String>) -> Result<RunStep, String>
control_factory_run(state, run_id: String, op: RunControl) -> Result<RunStep, String>
next_queued_factory_run(state, factory_id: String) -> Result<Option<String>, String>
get_factory_artifact(state, run_id: String, name: String) -> Result<Option<String>, String>
```

Decisions:
- One private helper does every transition so persistence is uniform:
  `async fn transition(state, run: FactoryRun, event: RunEvent, event_kind: &str, detail: &str) -> Result<RunStep, String>`: compute `line_busy` with `factory_line_busy(run.factory_id, run.id)`; `apply`; set `updated_at`; `update_factory_run`; `insert_factory_run_event(run.id, now, step_id_before, event_kind, detail)`; build `StepAction` (for `StartStation`: render the prompt with `render_prompt`, `agent = definition.agent`, `cwd = run.workspace_path`, `task = Some(TaskInfo{ title, branch, base_branch, worktree_path, repo_path, race_id: None })` for a worktree run and `None` for in-place). Event kinds used: `started`, `passed`, `failed`, `blocked`, `approved`, `rejected`, `resumed`, `retry_allowed`, `queued`, `cancelled`, `finished`. `detail` is the reject reason, or the first 500 chars of check output, else empty.
- `start_factory_run`: load factory (missing -> `user_err("This factory no longer exists.")`); `ensure_repo_trusted`; `input.trim()` empty -> `user_err("Enter the <input label, lowercased>.")`; if `definition.uses_input_in_check() && !input_is_safe(input)` -> `user_err("This factory passes the input to a check command, so it may only contain letters, digits and . _ : / # @ -")`. Run id is a v4 uuid; `run_dir = <factory_data_dir>/factory-runs/<run id>` (created). Worktree mode: `start_task_impl` with `title = "<factory name> <input>"`, `branch_name = Some("agentrium/factory-<slug(name)>-<slug(input)>")` where `slug` lowercases, maps every char outside `[a-z0-9]` to `-`, collapses repeats, trims `-`, caps at 40 chars; then `insert_task`. In-place: `workspace_path = repo_path`, `branch = None`. Insert the run as `Queued` with the factory's stored definition, then `transition(Start)`.
- `evaluate_factory_station`: run must be `Running`, else `user_err("This run is already being checked.")` when `Checking`, or the engine's wrong-state error otherwise. Then, with `station = definition.station(current_step)`:
  1. `artifact` set and `<run_dir>/<artifact>` missing: if `manual` -> `user_err("<artifact> is not in the run folder yet.")`, else return `RunStep { run, action: Waiting }` with no change.
  2. `check` set: set status `Checking` and persist; register `eval_id` in `running_checks()` (duplicate -> `user_err("That check is already running.")`), hold `CheckGuard(eval_id)`; `run_check(render_check_command(...), Path::new(&run.workspace_path), Duration::from_secs(station.timeout_secs()), cancel)` with env `AGENTRIUM_RUN_DIR` and `AGENTRIUM_FACTORY_INPUT` (if `run_check` has no env parameter, add an optional `envs: &[(String, String)]` parameter to it and pass `&[]` from the two existing call sites). `exit_code == Some(0)` and not timed out and not cancelled -> `StationPassed`. Cancelled -> set status back to `Running`, persist, return `Waiting`. Otherwise `StationFailed { output }` where output is `output_tail`, prefixed with `"Timed out after <n> s.\n"` on timeout. A spawn error from `run_check` -> status back to `Running`, persist, return the error.
  3. No check, artifact present -> `StationPassed`.
  4. Neither check nor artifact: `manual` -> `StationPassed`; else `Waiting`.
- `answer_factory_gate`: `approve` -> `GateApproved { step_id }`; else `GateRejected { step_id, reason: reason.unwrap_or_default() }`.
- `control_factory_run`: maps 1:1 to `Resume`, `AllowRetry`, `LineFreed`, `Cancel`.
- `get_factory_artifact`: `is_plain_file_name(name)` else `user_err("Not an artifact name.")`; missing file -> `Ok(None)`; larger than 2 MB -> `user_err("<name> is too large to show (over 2 MB).")`; non-UTF-8 -> `user_err("<name> is not a text file.")`.
- Missing run in any command -> `user_err("This run no longer exists.")`.

To keep these testable without `State`, put the logic in `pub(crate)` functions that take `&Database` and plain values (the commands lock through `db_op` and call them): `start_run_in(db, factory: &Factory, input: &str, data_dir: &Path, workspace: WorkspaceSpec) -> Result<RunStep, String>`, `evaluate_decision(run: &FactoryRun, manual: bool) -> Result<EvalDecision, String>` (`EvalDecision::{ Waiting, RunCheck { command: String, timeout: Duration }, Pass }`), `finish_evaluation(db, run, outcome: CheckOutcome) -> Result<RunStep, String>`, `answer_gate_in(db, run_id, step_id, approve, reason)`, `control_in(db, run_id, op)`, `read_artifact(run_dir: &Path, name: &str)`.

- [ ] **Step 1: Write the failing tests** (in `factory.rs`, `Database::new_in_memory()`, `tempfile::tempdir()` for data and workspace dirs, in-place workspace so no git is needed):
  - `start_creates_run_dir_and_first_station`: action is `StartStation` with `step_id "S1"`, `attempt 1`, prompt containing the input and the run dir, `cwd` = workspace, `task == None`; the run dir exists; one event `started`.
  - `start_refuses_blank_input`.
  - `start_refuses_unsafe_input_when_a_check_uses_it`: input `"A-1; rm -rf ."` -> `Err` containing `"may only contain"`; `list_factory_runs` is empty and no run dir was created.
  - `start_allows_free_text_input_when_no_check_uses_it`: remove the check from the sample, input `"fix the login bug"` -> `Ok`.
  - `second_in_place_run_is_queued`: two starts -> second action `Queued`.
  - `evaluate_waits_for_a_missing_artifact`: `evaluate_decision(run, false) == Waiting`; with `manual true` -> `Err` containing `"plan.md is not in the run folder yet."`.
  - `evaluate_runs_the_check_when_the_artifact_exists`: write `plan.md` -> `RunCheck { command: "node check.js A-1", timeout: 300 s }`.
  - `evaluate_refuses_a_run_that_is_already_checking`: status `Checking` -> `Err` `"This run is already being checked."`, and the stored run is unchanged.
  - `station_with_neither_passes_only_manually`: S2 -> `Waiting` for `manual false`, `Pass` for `true`.
  - `finish_evaluation_pass_moves_to_gate_and_logs`: events `["started", "passed"]`, action `AwaitGate { "G1" }`.
  - `finish_evaluation_fail_restarts_with_output_in_prompt`: prompt of the returned `StartStation` contains the failure text; `attempt == 2`.
  - `reject_restarts_station_with_reason_in_prompt`.
  - `approve_then_last_station_manual_pass_finishes`: final action `Finished`, status `Done`.
  - `cancel_then_line_freed_starts_the_queued_run`: cancel run A, `next_queued` returns B, `control_in(B, LineFreed)` -> `StartStation`.
  - `read_artifact_cases`: plain text -> `Some`; missing -> `None`; `"../x"` -> `Err`; a 3 MB file -> `Err` containing `"too large"`.
  - One `#[tokio::test]` `check_exit_code_decides_pass_or_fail`: run a real check through the command path helper with a command that exits 0 and one that exits 1 (`cmd /C exit 1` on Windows, `sh -c 'exit 1'` elsewhere, picked with `cfg!(windows)`), asserting `passed` then `failed` events.
- [ ] **Step 2: Run** `cd src-tauri && cargo test --locked factory::`. Expected: compile failure.
- [ ] **Step 3: Implement** the functions and the ten commands; register them in `main.rs`.
- [ ] **Step 4: Run** `cd src-tauri && cargo test --locked factory` then `cargo test --locked races` (the `run_check` signature may have changed) then `cargo clippy --locked -- -D warnings` and `cargo fmt --check`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(factory): run lifecycle commands, checks, gates and artifacts"
```

---

### Task 6: Frontend types, IPC wrappers and pure helpers

**Files:**
- Create: `src/lib/factory.ts`, `src/lib/factory.test.ts`

**Interfaces:**
- Consumes: `AgentKind` type (same import path `src/lib/races.ts` uses), `TaskInfo` from `./tasks`, `invoke` from `@tauri-apps/api/core`.
- Produces (types mirror the Rust wire formats exactly: `Definition` tree snake_case, the rest camelCase):

```ts
export type Workspace = 'worktree' | 'in_place';
export interface Check { command: string; timeout_sec?: number | null }
export interface StationStep { kind: 'station'; id: string; name: string; prompt: string; artifact?: string | null; check?: Check | null; loop_cap?: number | null }
export interface GateStep { kind: 'gate'; id: string; name: string; question: string; pass_label: string; reject_label: string; show: string[]; notes: string[]; on_reject: string }
export type Step = StationStep | GateStep;
export interface Definition { version: number; name: string; source: string; source_sha256: string; input: { label: string; placeholder: string }; workspace: Workspace; agent: AgentKind; rules: string[]; steps: Step[] }
export interface LintItem { step_id: string | null; message: string }
export interface Lint { errors: LintItem[]; warnings: LintItem[] }
export interface DefinitionReview { definition: Definition | null; parseError: string | null; lint: Lint }
export type DiskState = 'same' | 'changed' | 'missing';
export interface Factory { id: string; name: string; repoPath: string; sourcePath: string; definition: Definition; createdAt: string; updatedAt: string; diskState: DiskState }
export interface FactoryCandidate { path: string; relPath: string; hasDefinition: boolean }
export interface ImportTicket { importId: string; outputPath: string; prompt: string }
export type RunStatus = 'queued' | 'running' | 'checking' | 'waiting_gate' | 'blocked' | 'done' | 'cancelled';
export interface FactoryRun { id: string; factoryId: string; input: string; status: RunStatus; currentStep: string; attempts: Record<string, number>; rejectReason: string; checkOutput: string; definition: Definition; workspacePath: string; branch: string | null; runDir: string; terminalId: string | null; createdAt: string; updatedAt: string }
export type StepAction =
  | { kind: 'start_station'; stepId: string; stepName: string; attempt: number; prompt: string; agent: AgentKind; cwd: string; task: TaskInfo | null }
  | { kind: 'await_gate'; stepId: string }
  | { kind: 'queued' } | { kind: 'blocked' } | { kind: 'finished' } | { kind: 'cancelled' } | { kind: 'waiting' };
export interface RunStep { run: FactoryRun; action: StepAction }
export interface RunEventRow { at: string; stepId: string; kind: string; detail: string }
export type RunControl = 'resume' | 'allow_retry' | 'line_freed' | 'cancel';

// IPC wrappers, one per command of Tasks 4 and 5, same names in camelCase:
listFactoryCandidates(repoPath), readFactoryDefinitionFile(repoPath, sourcePath), beginFactoryImport(repoPath, sourcePath),
pollFactoryImport(importId), saveFactory(repoPath, sourcePath, definition, writeFile), listFactories(), deleteFactory(factoryId),
startFactoryRun(factoryId, input), listFactoryRuns(), getFactoryRunEvents(runId), setFactoryRunTerminal(runId, terminalId),
evaluateFactoryStation(runId, manual, evalId), cancelFactoryCheck(evalId), answerFactoryGate(runId, stepId, approve, reason),
controlFactoryRun(runId, op), nextQueuedFactoryRun(factoryId), getFactoryArtifact(runId, name)

// pure helpers
export const FACTORY_TAB_PREFIX = 'factory:';
export function factoryTabPath(factoryId: string): string;
export function isOpenRun(run: FactoryRun): boolean;                 // not done, not cancelled
export function needsYou(run: FactoryRun): boolean;                  // waiting_gate || blocked
export function holdsLine(run: FactoryRun): boolean;                 // running || checking
export function currentStep(run: FactoryRun): Step | undefined;
export type TrackCell = 'done' | 'current' | 'needs-you' | 'blocked' | 'todo';
export function trackFor(run: FactoryRun): { step: Step; cell: TrackCell }[];
export function stepCounts(def: Definition, runs: FactoryRun[]): Record<string, number>;   // open runs per current step id
export function runStatusText(run: FactoryRun): string;
export function sessionLabel(factoryName: string, run: FactoryRun, stepName: string): string;  // `${factoryName}: ${input} · ${stepName}` with input cut to 40 chars
```

`runStatusText` copy (exact): queued -> `"Queued, waiting for the line"`; running -> `"<step name>, attempt <n> of <cap>"` (cap = `loop_cap ?? 3`); checking -> `"Checking <step name>"`; waiting_gate -> `"Waiting for you at <gate name>"`; blocked -> `"Blocked at <step name>, <n> of <cap> attempts used"`; done -> `"Done"`; cancelled -> `"Cancelled"`.

`trackFor`: steps before the current index are `done`; the current one is `needs-you` for `waiting_gate`, `blocked` for `blocked`, otherwise `current`; later ones `todo`. For `done` every cell is `done`; for `cancelled` cells before current are `done` and the rest `todo`.

- [ ] **Step 1: Write the failing tests** in `src/lib/factory.test.ts` with `vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))` and fixtures `def()` (S1 station with cap 3, G1 gate, S2 station) and `run(partial)`:
  - `needsYou` true only for `waiting_gate` and `blocked`; `isOpenRun` false for `done` and `cancelled`; `holdsLine` true only for `running` and `checking`.
  - `trackFor` for a run waiting at G1 -> cells `['done', 'needs-you', 'todo']`; blocked at S1 -> `['blocked', 'todo', 'todo']`; done -> all `done`.
  - `stepCounts` counts only open runs.
  - `runStatusText` for each of the seven statuses equals the copy above.
  - `sessionLabel` cuts a 60-char input to 40 chars.
  - One wrapper test: `evaluateFactoryStation('r1', true, 'e1')` calls `invoke('evaluate_factory_station', { runId: 'r1', manual: true, evalId: 'e1' })`; `answerFactoryGate('r1', 'G1', false, 'why')` calls `invoke('answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: false, reason: 'why' })`.
- [ ] **Step 2: Run** `npx vitest run src/lib/factory.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/factory.ts`.
- [ ] **Step 4: Run** `npx vitest run src/lib/factory.test.ts` and `npx tsc --noEmit`. Expected: pass, no type errors.
- [ ] **Step 5: Commit**

```bash
git add src/lib/factory.ts src/lib/factory.test.ts
git commit -m "feat(factory): frontend types, ipc wrappers and helpers"
```

---

### Task 7: Store, step performer and tracking

**Files:**
- Create: `src/store/factoryStore.ts`, `src/store/factoryStore.test.ts`, `src/lib/factoryActions.ts`, `src/lib/factoryActions.test.ts`
- Modify: `src/store/appStore.ts` (add `factoryEnabled: boolean` default `false`, `setFactoryEnabled(v: boolean)`, include it in `partialize`; no persist version bump is needed for an added optional field, follow how `contextMeterEnabled` was added)

**Interfaces:**
- Consumes: Task 6; `useTerminalStore` (`createTerminal` positional signature, `closeTerminal(id)`, `terminals`, `terminalStates`, `activeTerminalId`, `setActiveTerminal`); `resolveLaunchConfig`, `needsStaging` from `../lib/tasks`; `useAppStore` (`setPromptDraft`, `defaultAgentArgs`, `activeFilePath`, `setActiveFilePath`); the agent registry's `defaultBindingsFor(agent)` (same access `launchTask` uses); `toast`; `reportInvokeFailure`.
- Produces:

```ts
// src/lib/factoryActions.ts
export async function performStep(step: RunStep, factoryName: string): Promise<void>;
export async function kickQueue(factoryId: string): Promise<void>;
export async function launchImportSession(repoPath: string, prompt: string, agent: AgentKind): Promise<string>; // terminal id

// src/store/factoryStore.ts
interface FactoryStoreState {
  factories: Record<string, Factory>;
  runs: Record<string, FactoryRun>;
  loaded: boolean;
  evaluating: Record<string, true>;       // run ids with an evaluation in flight
  seenBusy: Record<string, true>;         // terminal ids seen busy since their station started
  load: () => Promise<void>;
  upsertFactory: (f: Factory) => void;
  removeFactory: (id: string) => void;
  applyStep: (step: RunStep) => Promise<void>;                        // store the run, performStep, then kickQueue when the run no longer holds the line
  startRun: (factoryId: string, input: string) => Promise<FactoryRun>;
  evaluate: (runId: string, manual: boolean) => Promise<void>;
  answerGate: (runId: string, stepId: string, approve: boolean, reason: string) => Promise<void>;
  control: (runId: string, op: RunControl) => Promise<void>;
}
export const useFactoryStore: UseBoundStore<StoreApi<FactoryStoreState>>;
export function needsYouCount(runs: Record<string, FactoryRun>): number;
export function runsForFactory(runs: Record<string, FactoryRun>, factoryId: string): FactoryRun[];  // open runs first, then newest first
export function hasLiveSession(run: FactoryRun): boolean;             // terminalId set and present in useTerminalStore.terminals
export function trackFactoryRuns(): void;
export function subscribeFactoryTracking(): () => void;
```

Decisions:
- `performStep`, by `action.kind`:
  - `start_station`: remember `prevActive = activeTerminalId` and `prevFile = activeFilePath`. If `run.terminalId` is a live terminal, `closeTerminal` it. `launch = resolveLaunchConfig(action.agent, null, defaultAgentArgs, defaultBindingsFor(action.agent))`. `label = sessionLabel(factoryName, run, action.stepName)`. `id = await createTerminal(label, action.cwd, launch.args, launch.envVars, undefined, label, undefined, undefined, false, undefined, action.agent, launch.bindings, action.task, { initialPrompt: action.prompt })`. If `needsStaging(config.prompt_delivery)` -> `setPromptDraft(id, action.prompt)` and `toast.info('Prompt staged', 'Press Enter in the session to start this station.')`. Then `setFactoryRunTerminal(run.id, id)` and update the stored run's `terminalId`. Focus: if the user was looking at the run's previous terminal, leave the new one active; otherwise restore `prevActive` and `prevFile` (a station starting must not steal focus). If `createTerminal` throws: `toast.error('Could not start the station', String(err))`, `reportInvokeFailure('create_terminal', err)`, leave the run as is (the floor shows Continue).
  - `await_gate`: close the run's live terminal; `toast.info('Gate waiting', '<factoryName>: <input> needs your answer.')`.
  - `finished` and `cancelled`: close the run's live terminal.
  - `blocked`: leave the terminal open; `toast.warning('Run blocked', '<factoryName>: <input>')`.
  - `queued`, `waiting`: nothing.
- `kickQueue(factoryId)`: `nextQueuedFactoryRun`; if an id comes back, `control(id, 'line_freed')`. Errors are swallowed with the comment `// best effort: the next transition retries the queue`.
- `evaluate(runId, manual)`: returns immediately if `evaluating[runId]`. Sets the flag, calls `evaluateFactoryStation(runId, manual, crypto.randomUUID())`, `applyStep`, clears the flag in `finally`. On `waiting`, delete `seenBusy[terminalId]` so the next busy-to-idle edge triggers again. Errors: when `manual`, `toast.error('Check did not run', String(err))` plus `reportInvokeFailure('evaluate_factory_station', err)`; when not manual, swallow with the comment `// background evaluation: the user can press Check now`.
- `trackFactoryRuns()`: for each run with `status === 'running'` and a live terminal: `state = terminalStates.get(terminalId)`; if `state === 'busy'` set `seenBusy[terminalId]`; if `seenBusy[terminalId]` and (`state === 'idle'` or the terminal's `config.status` is `'Stopped'` or `'Error'`) and not `evaluating[run.id]` -> `evaluate(run.id, false)`. A terminal whose status is `'Stopped'` or `'Error'` triggers even without `seenBusy`. State `'waiting'` (the agent is asking the user something) never triggers.
- `subscribeFactoryTracking()`: no-op returning a no-op when `useAppStore.getState().factoryEnabled` is false. Otherwise `load()`, then subscribe to `useTerminalStore` and `useFactoryStore` and call `trackFactoryRuns` coalesced in a microtask, the same way `subscribeRaceTracking` does. Returns the unsubscribe.
- `load()`: `listFactories()` and `listFactoryRuns()` in parallel into the two records; sets `loaded`. No session is started on load.
- `launchImportSession`: same `createTerminal` call shape with `label = 'Factory import'`, `cwd = repoPath`, `task = null`, staged fallback identical.

- [ ] **Step 1: Write the failing tests.** Mock `@tauri-apps/api/core` `invoke`; set `useTerminalStore.setState({ terminals, terminalStates })` with the `terminal(id, ...)` fixture shape used in `raceStore.test.ts`; replace `createTerminal` and `closeTerminal` on the store with `vi.fn()`.

  `factoryActions.test.ts`:
  - `start_station opens a session with the prompt and records its id`: `createTerminal` called once with `action.cwd` as 2nd arg and `{ initialPrompt: action.prompt }` as last arg; `invoke('set_factory_run_terminal', { runId, terminalId: 'new' })`.
  - `start_station closes the previous station session first`.
  - `start_station restores the user's active terminal when they were elsewhere`: `activeTerminalId` was `'other'` -> `setActiveTerminal('other')` called after create; when it was the run's old terminal -> not called.
  - `a staged prompt is put in the draft, never written`: created config has `prompt_delivery: { mode: 'staged' }` -> `setPromptDraft('new', prompt)` called.
  - `await_gate closes the session`; `blocked leaves the session open`.
  - `kickQueue starts the next queued run`: `next_queued_factory_run` resolves `'r2'` -> `invoke('control_factory_run', { runId: 'r2', op: 'line_freed' })`.

  `factoryStore.test.ts`:
  - `load fills factories and runs`.
  - `needsYouCount counts gates and blocked runs`.
  - `a busy then idle station is evaluated once`: set state `busy`, `trackFactoryRuns()`, set `idle`, call `trackFactoryRuns()` twice -> `evaluate_factory_station` invoked exactly once with `manual: false`.
  - `an idle station that was never busy is not evaluated`.
  - `a station waiting for the user's answer is not evaluated` (state `'waiting'`).
  - `a stopped session is evaluated`.
  - `a run whose terminal is gone is not evaluated`: `terminalId: 't9'` absent from `terminals` -> no invoke, and `hasLiveSession(run) === false`.
  - `a waiting outcome re-arms on the next busy to idle edge`.
  - `answerGate applies the returned step and shows an error toast on failure`.
  - `subscribeFactoryTracking does nothing when the flag is off`: `invoke` not called.
- [ ] **Step 2: Run** `npx vitest run src/store/factoryStore.test.ts src/lib/factoryActions.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** both files and the `factoryEnabled` flag.
- [ ] **Step 4: Run** the two test files, `npx vitest run src/store/appStore.test.ts`, and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/store/factoryStore.ts src/store/factoryStore.test.ts src/lib/factoryActions.ts src/lib/factoryActions.test.ts src/store/appStore.ts
git commit -m "feat(factory): store, station launcher and turn tracking"
```

---

### Task 8: App plumbing (flag toggle, tab mode, modal state, hue)

**Files:**
- Modify: `src/store/appStore.ts`, `src/components/TerminalTabs.tsx`, `src/components/SettingsModal.tsx`, `src/App.tsx`, `src/index.css`, `src/lib/lsp/lspClient.ts`
- Create: `src/components/FactoryFloor.tsx` (placeholder body only: `export function FactoryFloor({ factoryId }: { factoryId: string })` rendering the factory name in an `EmptyState`; Task 9 fills it)
- Test: `src/store/appStore.test.ts`, `src/components/TerminalTabs.test.tsx`

**Interfaces:**
- Consumes: Task 7 `subscribeFactoryTracking`, Task 6 `factoryTabPath`, `FACTORY_TAB_PREFIX`.
- Produces (on `useAppStore`):

```ts
export type SidebarNav = 'sessions' | 'files' | 'history' | 'factory';
// FileTabState.mode: 'edit' | 'diff' | 'race' | 'factory'
openFactoryTab: (factoryId: string, name: string) => void;      // same shape as openRaceTab, path = factoryTabPath(id), content = name, sets gridMode false
addFactoryModalOpen: boolean; openAddFactoryModal: () => void; closeAddFactoryModal: () => void;
newFactoryRunFactoryId: string | null | undefined;              // undefined = closed, null = open with a picker, string = open for that factory
openNewFactoryRun: (factoryId?: string | null) => void; closeNewFactoryRun: () => void;
factoryGateRunId: string | null; openFactoryGate: (runId: string) => void; closeFactoryGate: () => void;
```

Decisions:
- CSS, added next to the existing nav hues in `src/index.css`: `--nav-factory: #38bdf8;` in `:root`, `--nav-factory: #0284c7;` in `:root[data-theme="light"]`, and `[data-hue="factory"] { --hue: var(--nav-factory); }`.
- `TerminalTabs.tsx`: the pill for a `mode === 'factory'` tab shows the lucide `Factory` icon and `tab.content`; the overlay switch renders `<FactoryFloor factoryId={activeFilePath.slice(FACTORY_TAB_PREFIX.length)} />` for that mode.
- `lspClient.ts`: skip `mode === 'factory'` tabs where it already skips `mode === 'race'`.
- `SettingsModal.tsx`: a toggle in the General section, directly under the context meter toggle, label `AI Factory`, description `Run your own agent production lines from a Markdown file in a repo. Experimental.` bound to `factoryEnabled`.
- `App.tsx`: `useEffect(subscribeFactoryTracking, [factoryEnabled])` next to `subscribeRaceTracking`. Modals are mounted in Tasks 10 to 12.
- Persisted `sidebarNav === 'factory'` with the flag off must render the Sessions body: in `setFactoryEnabled(false)` also set `sidebarNav` to `'sessions'` when it is `'factory'`, and close any open factory tabs.

- [ ] **Step 1: Write the failing tests.**
  - `appStore.test.ts`: `openFactoryTab adds one tab and focuses it` (path `factory:f1`, `mode 'factory'`, `content 'demo'`, second call does not duplicate, `gridMode` false); `turning the flag off leaves the factory navigator and closes factory tabs`; `openNewFactoryRun() opens with a picker and openNewFactoryRun('f1') opens for that factory` (`null` vs `'f1'`, `closeNewFactoryRun` -> `undefined`).
  - `TerminalTabs.test.tsx`: with an open `factory:f1` tab active, the placeholder floor is rendered (query the text of the factory name) and the pill shows it.
- [ ] **Step 2: Run** `npx vitest run src/store/appStore.test.ts src/components/TerminalTabs.test.tsx`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the changes above.
- [ ] **Step 4: Run** the two files and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts src/components/TerminalTabs.tsx src/components/TerminalTabs.test.tsx src/components/SettingsModal.tsx src/components/FactoryFloor.tsx src/App.tsx src/index.css src/lib/lsp/lspClient.ts
git commit -m "feat(factory): feature flag, factory tab mode and modal state"
```

---

### Task 9: Factory floor

**Files:**
- Modify: `src/components/FactoryFloor.tsx`
- Create: `src/components/FactoryFloor.test.tsx`

**Interfaces:**
- Consumes: Task 6 helpers (`trackFor`, `stepCounts`, `runStatusText`, `needsYou`), Task 7 store (`runsForFactory`, `hasLiveSession`, `evaluate`, `control`, `evaluating`), Task 8 (`openFactoryGate`, `openNewFactoryRun`, `openAddFactoryModal`), `focusTerminal` from `../lib/raceActions`, `confirmAction` from `../lib/confirmDialog`, `formatElapsed` from `../lib/races`, `useNowTick`.
- Produces: `export function FactoryFloor({ factoryId }: { factoryId: string })`.

Layout (match `factory-sketch.html` screen 2; class names follow `RaceHeader.tsx`):
- **Header bar** (`px-3 py-1.5 border-b border-seam bg-elevation-1`): `Factory` icon, factory name, a chip with `sourcePath` relative to `repoPath`, right side `+ New run` (`bg-accent-primary text-white`, calls `openNewFactoryRun(factoryId)`). When `diskState !== 'same'`: a warning strip under the header, text `Definition changed on disk. Review it before new runs use it.` (for `missing`: `The definition file is gone from the repo. Runs keep using the saved copy.`) with a `Review` button calling `openAddFactoryModal()`.
- **Line strip**: one node per step in order. Station: rounded box with name, id, and the count from `stepCounts` when non-zero. Gate: a diamond with the id and name; violet when its count is non-zero.
- **Runs list** (left, scrolls): one row per run from `runsForFactory`: status dot, `input` (mono), the track from `trackFor` (thin bars for stations, small diamonds for gates; colours: done `bg-success/75`, current `bg-accent-primary`, needs-you `var(--attention-input)`, blocked `bg-error`, todo `bg-elevation-3`), `runStatusText(run)` with elapsed since `updatedAt` under it, and one primary action:

| Run state | Button | Does |
|---|---|---|
| `waiting_gate` | `Review` | `openFactoryGate(run.id)` |
| `running`, live session | `Open` | `focusTerminal(terminalId)` |
| `running` or `checking`, no live session, not evaluating | `Continue` | `control(run.id, 'resume')` |
| `checking`, evaluating | `Checking...` (disabled) | |
| `blocked` | `Allow 1 more round` | `control(run.id, 'allow_retry')` |
| `queued` | none (text only) | |
| `done`, `cancelled` | none | |

  Each open run also has an overflow of two small icon buttons: `Check now` (only for `running` with a live session; `evaluate(run.id, true)`; label is `Mark done` when the current station has neither check nor artifact) and `Cancel run` (after `confirmAction('Cancel this run? Its session closes. Files it changed stay where they are.', { okLabel: 'Cancel run' })`, `control(run.id, 'cancel')`).
- **Needs you column** (right, `w-[292px] border-l border-seam bg-elevation-1`): heading `Needs you (<n>)`, one card per run where `needsYou(run)`; gate cards show the gate question and `Review`; blocked cards show `Blocked at <step>` and the last 3 lines of `checkOutput`. Empty: `EmptyState` with title `Nothing is waiting for you`.
- No runs at all: `EmptyState` title `No runs yet`, description `Start a run to send one <input label, lowercased> down the line.`, action `+ New run`.
- Unknown `factoryId`: `EmptyState` title `This factory was removed`.

- [ ] **Step 1: Write the failing tests** (`render` with `useFactoryStore.setState` fixtures, mock `invoke`):
  - `shows one row per run with its status text` (`getByText('Waiting for you at Plan approval')`).
  - `the line shows a count on the step that has runs`.
  - `Review on a gate run opens the gate dialog` (`useAppStore.getState().factoryGateRunId === 'r1'`).
  - `a running run with no live session offers Continue, and it resumes the run` (`invoke('control_factory_run', { runId, op: 'resume' })`).
  - `a running run with a live session offers Open, not Continue`.
  - `Allow 1 more round is offered only for a blocked run`.
  - `Mark done replaces Check now for a station with no check and no artifact`.
  - `Cancel run asks first` (mock `confirmAction` to resolve `false` -> no invoke; `true` -> `op: 'cancel'`).
  - `needs-you column lists gates and blocked runs and is empty otherwise`.
  - `a changed definition shows the review strip`.
  - `an unknown factory shows the removed state`.
- [ ] **Step 2: Run** `npx vitest run src/components/FactoryFloor.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component. Keep row and line strip as small private components in the same file.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/components/FactoryFloor.tsx src/components/FactoryFloor.test.tsx
git commit -m "feat(factory): factory floor view"
```

---

### Task 10: Gate dialog

**Files:**
- Create: `src/components/FactoryGateDialog.tsx`, `src/components/FactoryGateDialog.test.tsx`
- Modify: `src/App.tsx` (mount `{factoryGateRunId && <FactoryGateDialog key={`gate-${factoryGateRunId}`} />}` next to `RaceDecideDialog`)

**Interfaces:**
- Consumes: `Modal` from `./ui/Modal`; `getFactoryArtifact`; store `answerGate`; `useAppStore` `factoryGateRunId`, `closeFactoryGate`.
- Produces: `export function FactoryGateDialog()`.

Decisions:
- `Modal` with `title={gate.name}`, `showHeader`, `closeOn="none"`, `panelClassName="w-full max-w-4xl max-h-[88vh] flex flex-col"`. Sub-line under the title: `<factory name> · <run input>`.
- Left pane: one section per `gate.show` entry, heading = file name, body = the file text in a `<pre>` with `whitespace-pre-wrap` and the mono font (no Markdown rendering in this version). Loading state per file; a missing file (`null`) shows `<name> is not in the run folder.`; a load error shows the error text in `text-error`. Empty `show`: `This gate shows no files.`
- Right pane, top to bottom: the question (`text-[14px] font-medium`); `gate.notes` as a list under the heading `Passing also does`, hidden when empty; a `<textarea>` with label `Reason (required to <reject_label, lowercased>)`; two buttons, pass (`bg-accent-primary text-white`, text `gate.pass_label`) and reject (`text-error ring-1 ring-inset ring-error/40`, text `gate.reject_label`); the note `Agentrium records this answer. The agent cannot answer a gate.`
- Reject with an empty reason does not call IPC: the textarea gets `aria-invalid` and the inline message `Give a reason so the agent knows what to change.`
- Both buttons are disabled while a call is in flight. Success closes the dialog. Failure keeps it open; the error toast comes from the store.
- If the run is no longer `waiting_gate` at this gate when the dialog renders (answered elsewhere, cancelled), render `This gate was already answered.` with a `Close` button.

- [ ] **Step 1: Write the failing tests:**
  - `shows the question, the labels and the fixed note`.
  - `loads and shows each artifact` (`invoke('get_factory_artifact', { runId: 'r1', name: 'plan.md' })` resolves `'# Plan'`).
  - `a missing artifact says so`.
  - `approve sends the answer and closes` (`invoke('answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: true, reason: '' })`, then `factoryGateRunId === null`).
  - `reject without a reason is refused locally` (no `answer_factory_gate` call, message visible).
  - `reject with a reason sends it`.
  - `stays open when the answer fails`.
  - `a gate that is no longer waiting shows the already-answered state`.
- [ ] **Step 2: Run** `npx vitest run src/components/FactoryGateDialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/components/FactoryGateDialog.tsx src/components/FactoryGateDialog.test.tsx src/App.tsx
git commit -m "feat(factory): human gate dialog"
```

---

### Task 11: Add factory modal (pick, import, review, confirm)

**Files:**
- Create: `src/components/AddFactoryModal.tsx`, `src/components/AddFactoryModal.test.tsx`
- Modify: `src/App.tsx` (mount `{addFactoryModalOpen && <AddFactoryModal key="add-factory" />}`)

**Interfaces:**
- Consumes: `Modal`; `open` from `@tauri-apps/plugin-dialog`; `knownRepoPaths`, `repoPathForTerminal` from `../lib/tasks`; Task 6 wrappers `listFactoryCandidates`, `readFactoryDefinitionFile`, `beginFactoryImport`, `pollFactoryImport`, `saveFactory`; Task 7 `launchImportSession`, `upsertFactory`; `openFactoryTab`.
- Produces: `export function AddFactoryModal()`.

Flow (one modal, four steps shown in a stepper `Repo`, `Factory file`, `Check what Agentrium understood`, `Ready`):
1. **Repo**: text input with a `<datalist>` from `knownRepoPaths()`, prefilled from `repoPathForTerminal(activeTerminalId)`, and a `Browse` button using the same `open({ directory: true, multiple: false })` call as `NewRaceModal`. `Next` calls `listFactoryCandidates`.
2. **Factory file**: radio list of candidates showing `relPath`, with the tag `already set up` when `hasDefinition`. No candidates: `No factory files found. Put a Markdown file under .agentrium/ or .claude/skills/<name>/SKILL.md.` plus a `Browse for a file` button (`open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md'] }], defaultPath: repoPath })`). `Next`:
   - `readFactoryDefinitionFile` returns a review -> go to step 3 with `fromAgent = false`.
   - returns `null` -> `beginFactoryImport`, then `launchImportSession(repoPath, ticket.prompt, 'claude')`, then poll `pollFactoryImport(ticket.importId)` every 2000 ms. While polling show `Your agent is reading the file. This usually takes under a minute. You can watch it in the session "Factory import".` and a `Cancel` button that stops polling. When a review arrives: stop polling, go to step 3 with `fromAgent = true`. After 5 minutes without a result: stop polling and show `No definition was written. Open the "Factory import" session to see what happened, then try again.`
3. **Check**: if `parseError`: show it in `text-error` and only `Back`. Otherwise: errors list (red), warnings list (amber), then the steps: one row per step with id, name, a tag (`station`, `gate`), and for a station its artifact and its check command in a mono box. Above the steps, when any station has a check: the notice `These commands will run on your machine when a station finishes. Read them before you confirm.` Then input label, workspace (`One worktree per run` or `Works in the repo folder, one run at a time`), and the rules list under `Rules given to the agent (not enforced)`. `Confirm` is disabled while `lint.errors.length > 0`.
4. **Confirm** -> `saveFactory(repoPath, sourcePath, definition, fromAgent)`; `upsertFactory`; close; `openFactoryTab(factory.id, factory.name)`; `toast.success('Factory added', factory.name)`. Failure: inline `role="alert"` error and `reportInvokeFailure('save_factory', err)`.

Polling uses `setInterval` cleared on unmount and on leaving step 2; poll errors are swallowed with the comment `// poller: the next tick retries`.

- [ ] **Step 1: Write the failing tests** (mock `invoke` per command name with a `switch`, mock `@tauri-apps/plugin-dialog`, mock `../lib/factoryActions` `launchImportSession`, `vi.useFakeTimers()` for polling):
  - `lists candidates and marks the ones already set up`.
  - `a file with a definition goes straight to review without starting an agent` (`launchImportSession` not called).
  - `a file without a definition starts an import session and shows the review when the poll returns one` (advance timers by 2000 ms).
  - `import gives up after 5 minutes with the no-definition message`.
  - `Cancel during import stops polling` (advance timers, no further `poll_factory_import` calls).
  - `Confirm is disabled while there are lint errors, and the errors are listed`.
  - `the check command notice is shown only when a station has a check`.
  - `Confirm saves, writes the file only for an agent import, opens the floor` (assert `writeFile: true` after an import and `false` after an existing file; `openFiles` contains `factory:<id>`).
  - `a parse error shows the message and no Confirm`.
- [ ] **Step 2: Run** `npx vitest run src/components/AddFactoryModal.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the local `FIELD` / `INPUT` class constants pattern from `NewRaceModal.tsx`.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/components/AddFactoryModal.tsx src/components/AddFactoryModal.test.tsx src/App.tsx
git commit -m "feat(factory): add a factory from a repo file"
```

---

### Task 12: New run modal, New menu entry and shortcut

**Files:**
- Create: `src/components/NewFactoryRunModal.tsx`, `src/components/NewFactoryRunModal.test.tsx`
- Modify: `src/App.tsx` (mount `{newFactoryRunFactoryId !== undefined && <NewFactoryRunModal key="new-factory-run" />}`), `src/components/Sidebar.tsx` (`NewSessionSplitButton` gets an optional `onNewFactoryRun?: () => void` prop and a third menu item), `src/hooks/useKeyboardShortcuts.ts`, `src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: store `startRun`, `factories`; `useAppStore` `newFactoryRunFactoryId`, `closeNewFactoryRun`, `openNewFactoryRun`, `openFactoryTab`, `factoryEnabled`; `IconTile` (tone `blue`).
- Produces: `export function NewFactoryRunModal()`.

Decisions:
- Modal title `New run`. Fields: a `<select>` of factories by name, shown only when `newFactoryRunFactoryId === null` (preselect the factory of the active `factory:` tab if any, else the first); one text input whose label is `definition.input.label` and placeholder `definition.input.placeholder`, autofocused. Under it, one muted line: for `in_place`, `Runs in <repoPath>. If another run is building, this one waits in the queue.`; for `worktree`, `Gets its own worktree and branch.`
- Submit (`Start`, Enter): `startRun(factoryId, input)`; on success close, `openFactoryTab(factory.id, factory.name)`, `toast.success('Run started', input)`. On failure show the error inline with `role="alert"` (the backend messages from Task 5 are user-facing) and keep the modal open; call `reportInvokeFailure('start_factory_run', err)`.
- A `launching` ref guards double submit (same as `NewRaceModal`).
- No factories: body is `Add a factory first.` with a button `Add a factory` that closes this modal and calls `openAddFactoryModal()`.
- Menu item in `NewSessionSplitButton`, rendered only when `onNewFactoryRun` is passed: `<IconTile icon={Factory} tone="blue" size={18} />`, text `Factory run`, `aria-label="New Factory run"`, `<kbd>Ctrl+Shift+Y</kbd>`. `Sidebar` passes the prop only when `factoryEnabled`.
- Shortcut: `Ctrl+Shift+Y` (`Ctrl+Shift+F` is Global Search; N, S, E, L, V, F, T, R, D, K, W, G are taken). In `useKeyboardShortcuts.ts`, next to the New Race block: when `ctrl && shift && matchesKeyCode(e, 'Y')` and `factoryEnabled`, `preventDefault()` and `openNewFactoryRun(null)`.

- [ ] **Step 1: Write the failing tests:**
  - `NewFactoryRunModal.test.tsx`: `uses the factory's input label and placeholder`; `shows a factory picker only when opened globally`; `Start runs the factory and opens its floor` (`invoke('start_factory_run', { factoryId: 'f1', input: 'A-1' })`); `a refused start shows the message and stays open` (reject with `'Enter the ticket.'`); `with no factories it offers to add one`.
  - `Sidebar.test.tsx`: `the New menu has a Factory run entry only when the flag is on`.
  - Add to the existing shortcut test file if one exists (search for `useKeyboardShortcuts.test`); otherwise create `src/hooks/useKeyboardShortcuts.factory.test.ts` with `Ctrl+Shift+Y opens the new run modal when the flag is on and does nothing when it is off`.
- [ ] **Step 2: Run** `npx vitest run src/components/NewFactoryRunModal.test.tsx src/components/Sidebar.test.tsx src/hooks`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/components/NewFactoryRunModal.tsx src/components/NewFactoryRunModal.test.tsx src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/hooks src/App.tsx
git commit -m "feat(factory): start a run from the floor, the New menu or Ctrl+Shift+Y"
```

---

### Task 13: Sidebar (Factory navigator and Sessions group)

**Files:**
- Create: `src/components/FactoryNavigator.tsx`, `src/components/FactoryNavigator.test.tsx`, `src/components/FactorySidebarGroups.tsx`, `src/components/FactorySidebarGroups.test.tsx`
- Modify: `src/components/Sidebar.tsx`, `src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: Task 7 `needsYouCount`, `runsForFactory`, `hasLiveSession`; Task 6 `needsYou`, `isOpenRun`, `currentStep`, `runStatusText`; Task 8 actions; `focusTerminal`; `deleteFactory`; `confirmAction`.
- Produces: `export function FactoryNavigator()`, `export function FactorySidebarGroups()`.

Decisions (match `sidebar-layout.html` states A, B and D):
- `Sidebar.tsx`: `NavItem.hue` becomes `'sessions' | 'files' | 'history' | 'factory'`. `NAV` is built per render: the three existing entries, plus `{ id: 'factory', label: 'Factory', Icon: Factory, hue: 'factory' }` when `factoryEnabled`. Both the expanded tab and the collapsed rail button for `factory` render a count pip when `needsYouCount(runs) > 0`: `<span aria-label="<n> waiting for you">` absolutely positioned top right, `min-w-[14px] h-[14px] rounded-full text-[9.5px] font-semibold`, background `var(--attention-input)`, text `#1b1230`. Body: `nav === 'factory' && factoryEnabled` renders `<FactoryNavigator />`; if `nav === 'factory'` and the flag is off, render the Sessions body. In the Sessions body, `<FactorySidebarGroups />` goes directly above `<RaceSidebarGroups />` when the flag is on.
- `FactoryNavigator`:
  - Section `Needs you <n>`: rendered only when n > 0. One row per run where `needsYou`: a tag with the current step id (violet for a gate, `bg-error/20 text-error` for blocked), `input` in mono, elapsed. Click: gate -> `openFactoryGate(run.id)`; blocked -> `openFactoryTab(factory.id, factory.name)`.
  - Section `Factories <n>`: one card per factory, sorted by name: status dot (violet if any run needs you, else pulsing accent if any run holds the line, else grey), name, `<repo folder name> / <source file name>` in mono, a counts line (`<n> runs`, then `<n> need you` in violet when > 0, then `<n> blocked` in `text-error` when > 0; `No runs` when there are no open runs). Click opens the floor tab. Context actions on hover: `New run` (`openNewFactoryRun(factory.id)`) and `Remove` (after `confirmAction('Remove this factory from Agentrium? Its files in the repo are not touched.', { okLabel: 'Remove' })`, `deleteFactory` then `removeFactory`; on failure `toast.error('Could not remove the factory', String(err))` and `reportInvokeFailure('delete_factory', err)`).
  - Last: a dashed button `Add a factory from a repo file` -> `openAddFactoryModal()`.
  - No factories: `EmptyState` title `No factories yet`, description `A factory runs your own process station by station and stops at each human gate.`, action `Add a factory`.
- `FactorySidebarGroups`: one group per factory that has at least one open run, newest factory activity first; returns `null` when there are none. Group container `mx-2 mb-2 rounded-xl ring-1 ring-inset ring-seam bg-elevation-1` (as `RaceGroup`). Header button: `Factory` icon in `var(--nav-factory)`, name, `<n> runs`; opens the floor. Rows: at most 5 open runs, needs-you first: status dot, `input` in mono (truncate), right-aligned short status: `<step id> needs you` (violet, bold) for a gate, `<step name> blocked` (`text-error`) for blocked, `<step name>` otherwise, `Queued` for queued. Row click: gate -> `openFactoryGate`; live session -> `focusTerminal`; otherwise open the floor. More than 5: a last line `<n> more`.

- [ ] **Step 1: Write the failing tests:**
  - `Sidebar.test.tsx`: `the Factory navigator tab is absent when the flag is off`; `it is present with a pip showing the needs-you count when the flag is on`; `a persisted factory nav with the flag off shows Sessions`; `with no factories the Sessions tab is unchanged` (no element with `data-factory-group`).
  - `FactoryNavigator.test.tsx`: `lists factories with run counts`; `Needs you lists gate and blocked runs and opens the gate dialog for a gate`; `the section is hidden when nothing waits`; `clicking a factory opens its floor tab`; `Remove asks first and removes on confirm`; `empty state offers to add a factory`.
  - `FactorySidebarGroups.test.tsx`: `renders nothing without open runs`; `one group per factory with open runs, needs-you runs first`; `shows at most 5 rows and an "n more" line`; `a row for a running run with a live session focuses its terminal`.
- [ ] **Step 2: Run** `npx vitest run src/components/Sidebar.test.tsx src/components/FactoryNavigator.test.tsx src/components/FactorySidebarGroups.test.tsx`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Give each group root `data-factory-group={factory.id}`.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/components/FactoryNavigator.tsx src/components/FactoryNavigator.test.tsx src/components/FactorySidebarGroups.tsx src/components/FactorySidebarGroups.test.tsx
git commit -m "feat(factory): factory navigator and sessions group in the sidebar"
```

---

### Task 14: Full verification, manual pass and docs

**Files:**
- Modify: `CLAUDE.md` (repo root of `agentrium/`)
- Create: `docs/superpowers/plans/fixtures/demo.md` and `docs/superpowers/plans/fixtures/demo.factory.json` (a 2-station, 1-gate factory with no check commands, used for the manual pass)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Run the whole suite.** From the repo root: `npx tsc --noEmit` and `npm run test:run`. From `src-tauri`: `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`. Expected: all green. Fix anything red before continuing; do not skip a test.

- [ ] **Step 2: Write the demo fixture.** `demo.factory.json`: `workspace: "worktree"`, input label `Topic`, station `S1` "Outline" (prompt: `Write a 5 line outline about {input} to {run_dir}/outline.md. {reject_reason}`, artifact `outline.md`), gate `G1` "Outline approval" (question `Use this outline?`, pass `Use it`, reject `Change it`, show `["outline.md"]`, on_reject `S1`), station `S2` "Write" (prompt: `Read {run_dir}/outline.md and write the piece to {run_dir}/piece.md.`, artifact `piece.md`). `demo.md`: the same process as four sentences of prose.

- [ ] **Step 3: Manual pass.** Use the `local-qa` skill in this repo to start the app (it has the rule about never touching the running production instance or port 5173). In a scratch git repo, copy the two fixture files into `.agentrium/`. Then check, in order, and record each result in the task report:
  1. With the flag off there is no Factory tab, no menu entry, and `Ctrl+Shift+Y` does nothing.
  2. Turn the flag on in Settings > General. Add the factory: the review screen lists S1, G1, S2 and no check notice. Confirm opens the floor.
  3. Start a run with input `tides`. A session opens; when the agent stops and `outline.md` exists the row moves to `Waiting for you at Outline approval` without any click, and the sidebar pip shows 1.
  4. Open the gate: the outline text is shown. Reject with a reason: a new session starts and its prompt contains the reason.
  5. Approve: S2 runs, the run ends as `Done`, the session is closed.
  6. Start a run, close its session by hand: the row offers `Continue`, and Continue reopens the station.
  7. Quit and restart the app with a run waiting at the gate: it is still there.
  8. Delete `demo.md`'s sibling json content and write `{` into it: the floor shows the changed-on-disk strip and the factory still lists.

- [ ] **Step 4: Update `CLAUDE.md`.** Add one bullet to the "IPC Commands" list, in the same dense style as the Race mode bullet, naming the 17 commands and stating: the definition file format and location, that `factory_engine::apply` is the only place a run changes state, that a check runs only from the definition stored on the run row, that gates are answered only through `answer_factory_gate` from `FactoryGateDialog`, that station prompts are never typed into a PTY, the `factoryEnabled` flag, and that factories are local only and never synced. Add `factory_def.rs`, `factory_engine.rs`, `factory.rs` to the project structure tree.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/fixtures
git commit -m "docs(factory): document the AI Factory commands and add a demo factory"
```

---

## Out of scope for this plan (next plans)

1. Polled gates, gate effects, per-agent tool-call guard hooks.
2. Improve: per-step run statistics, rejection reasons as input, agent-proposed diff to the Markdown, "Describe your process" drafting.
