# Insight Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-session "insight layer" panel above xterm that turns the agent's transcript JSONL into per-turn digests (stats, activity, files, errors, tables/charts) and renders pending `AskUserQuestion` prompts as a clickable box that answers through the PTY.

**Architecture:** Rust tails the session transcript (Claude `~/.claude/projects/...jsonl`, Codex `rollout-*.jsonl`) from a byte offset with a 500 ms polling loop per terminal, normalizes each line into a small agent-agnostic `InsightRecord`, and emits `insight-records` events only while the layer is on. The frontend buffers records per terminal (300 ms flush), a pure `insightModel.ts` folds them into turns, and `components/insight/*` renders them between `TerminalSearch` and the xterm container in `TerminalView`. The on/off flag lives on `TerminalConfig` (`#[serde(default)] insight_layer`) so it rides the existing last-session save/restore.

**Tech Stack:** Tauri 2 / Rust (serde_json, tokio), React 18 + TypeScript, Zustand, Tailwind, lucide-react, Vitest + Testing Library. No new dependencies: tables, bar and line charts are inline SVG/HTML.

**Spec:** `docs/superpowers/specs/2026-11-05-insight-layer-design.md`

**Worktree:** `C:\Users\tal\.agentrium-worktrees\agentrium\insight-layer`, branch `feat/insight-layer` (off `origin/master`, no upstream). Run every command from there; Rust commands from `src-tauri/`.

## Global Constraints

- Read `CLAUDE.md` in the repo root first. Its error-handling rules apply: every new `#[command]` body is wrapped in `wrap_cmd("name", ...)`; user-caused failures use `error_reporter::user_err`; background failures use `error_reporter::report_bg`. Frontend user actions use `.catch(err => { toast.error(...); reportInvokeFailure('<cmd>', err); })`; background calls use `.catch(() => {})` with a one-line reason comment.
- Never use an em-dash or en-dash in code, comments, copy, or commit messages. Use a hyphen.
- On/off is **per session (per terminal)**; the per-session flag always wins over the global default.
- Rust field uses `#[serde(default)]` so old saved rows load as off.
- When off, zero cost: no tailer task, no event listener, no parsing, no layer component mounted.
- Do not scrape the terminal for structured data. Screen state is used only for the fallback and the `waiting` gate.
- Unknown JSONL record types are skipped, never crash. A malformed line is skipped.
- No LLM calls in v1 (leave the `HeadlineProvider` hook). No change to agentrium-api or the sync payload: `insight_layer` must not be added to any sync row.
- No new npm or cargo dependency. Charts are inline SVG.
- Follow existing theme tokens (`--elevation-*`, `accent-primary`, light/dark), Tailwind classes, and `lucide-react` icons.
- Throttle UI updates to one flush per 300 ms per terminal. Cap stored records at 5000 per terminal and rendered turns at 50.
- Nothing pushed, merged, or released without asking the user.

## Review Focus

1. **Session id rotates while the layer is on** (`/clear`, resume, fork rebinding `claude_session_id`): the layer must reset to the new transcript, never mix turns from two sessions. Test in Task 3 (`tailer_resets_when_path_changes`) and Task 6 (`reset replaces records`).
2. **Transcript line written in two chunks** (poll lands mid-line): the partial line must be held and parsed once complete, never dropped or parsed half. Test in Task 3 (`partial_line_is_carried_to_next_poll`).
3. **Huge existing transcript** (100+ MB) when the layer is toggled on: attach reads only the last 4 MiB, starting at the first full line. Test in Task 3 (`initial_attach_reads_only_tail_window`).
4. **"Other" free text containing a newline or a multi-question / multi-select prompt**: newlines would submit early in the TUI, so they are replaced with spaces, and each question gets its own key group. Test in Task 7.
5. **User answers in the terminal directly while the box is shown, then clicks the box**: the click must send nothing once the question is no longer pending or the session is no longer `waiting`. Test in Task 10 (`does not send when the question is no longer pending`).

---

## File Structure

Rust (`src-tauri/`):
- Create `src/insight_parse.rs`: `InsightRecord` enum, `parse_claude_line`, `parse_codex_line`, text helpers. Pure, no IO.
- Create `src/insight.rs`: `TailState` (byte-offset reader), tailer registry, `insight_start` / `insight_stop` impl, event emission.
- Create `tests/insight_claude_fixture.jsonl`, `tests/insight_codex_fixture.jsonl`.
- Modify `src/session_provider.rs` (two trait methods), `src/claude_session.rs`, `src/codex_session.rs` (lookup by session id), `src/terminal.rs` (field + setter), `src/commands.rs` (request field + 3 commands), `src/main.rs` (mod + register), `src/database.rs` (test literal).

Frontend (`src/`):
- Create `lib/insightModel.ts` (+ test): records to turns. Pure.
- Create `lib/structuredOutput.ts` (+ test): detects table / bars / line / markdown blocks. Pure.
- Create `lib/questionKeys.ts` (+ test): answer to PTY key groups. Pure.
- Create `store/insightStore.ts`: per-terminal records + layer UI state (not persisted).
- Create `hooks/useInsightFeed.ts` (+ test): start/stop tailer, listen, throttle.
- Create `components/insight/`: `InsightLayer.tsx`, `TurnDigest.tsx`, `StatTiles.tsx`, `ActivityBars.tsx`, `FilesTouched.tsx`, `StructuredResult.tsx`, `MiniMarkdown.tsx`, `charts.tsx`, `QuestionBox.tsx`, `InsightCollapsedBar.tsx`, plus `InsightLayer.test.tsx`, `QuestionBox.test.tsx`, `StructuredResult.test.tsx`.
- Modify `components/TerminalView.tsx`, `components/TerminalStatusBar.tsx`, `components/CommandPalette.tsx`, `hooks/useKeyboardShortcuts.ts`, `lib/keymap.ts`, `lib/terminalState.ts`, `store/terminalStore.ts`, `store/appStore.ts` (+ `appStore.test.ts`), `App.tsx` (restore), one settings page under `components/settings/categories/`.

---

### Task 1: Rust record type and Claude line parser

**Files:**
- Create: `src-tauri/src/insight_parse.rs`, `src-tauri/tests/insight_claude_fixture.jsonl`
- Modify: `src-tauri/src/main.rs` (add `mod insight_parse;`)

**Interfaces:**
- Produces:

```rust
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InsightRecord {
    UserPrompt { ts: Option<String>, text: String },
    AssistantText { ts: Option<String>, text: String },
    ToolUse { ts: Option<String>, id: String, name: String, target: Option<String>, input: Option<serde_json::Value> },
    ToolResult { ts: Option<String>, tool_use_id: String, is_error: bool, text: String, lines_added: Option<u32>, lines_removed: Option<u32> },
    Usage { ts: Option<String>, message_id: String, input_tokens: u64, output_tokens: u64 },
}
pub fn parse_claude_line(line: &str) -> Vec<InsightRecord>;
pub(crate) fn clip_result_text(s: &str) -> String; // head 1024 + "\n...\n" + tail 3072 chars when longer than 4096
```

Parsing rules (verified against real transcripts on 2026-11-05):
- Only `type == "user"` and `type == "assistant"` records produce output. Every other type (`attachment`, `api-request*`, `system`, `mode`, `cost-state`, `file-history-snapshot`, ...) returns `vec![]`. Records with `isSidechain: true` or `isMeta: true` return `vec![]`.
- `ts` = top-level `timestamp` if present (tool-result records often have none).
- User record, `message.content` string or `text` blocks: one `UserPrompt` with the joined text, unless the trimmed text starts with `<` (command / reminder wrappers), then nothing.
- User record `tool_result` blocks: one `ToolResult` each. `text` = string content, or the joined `text` of array content, through `clip_result_text`. `is_error` = block `is_error` or false. Line counts from top-level `toolUseResult`: if it has `structuredPatch` (array of hunks with `lines: [String]`), count lines starting with `+` and `-`; else if `type == "create"` count lines of `content` as added; else if `oldString`/`newString` present, count their lines as removed/added; else `None`.
- Assistant record `text` blocks: `AssistantText`. `tool_use` blocks: `ToolUse` with `target` = first present string of `file_path`, `notebook_path`, `path`, `command`, `pattern`, `url`, `query`, `description` in `input`, truncated to 300 chars; `input` = `Some(input)` only when `name == "AskUserQuestion"`, else `None`. `thinking` blocks are ignored.
- Assistant record with `message.usage` and `message.id`: one `Usage` (`input_tokens` = `input_tokens + cache_creation_input_tokens`, `output_tokens`). Emitted once per record; the frontend dedupes by `message_id`.

- [ ] **Step 1: Write the fixture.** `tests/insight_claude_fixture.jsonl`, 9 lines, one per case: a `mode` record; a user prompt (string content) "fix the sync test"; a user `<command-name>/clear</command-name>` record; an assistant record with a `text` block + usage (`id: "msg_1"`, input 10, cache_creation 5, output 7); an assistant `tool_use` Edit (`id: "toolu_e"`, `file_path: "src/a.rs"`); a user `tool_result` for `toolu_e` with `toolUseResult.structuredPatch` `[{"lines":[" x","-old","+new","+new2"]}]`; an assistant `tool_use` Bash (`id: "toolu_b"`, `command: "cargo test"`); a user `tool_result` for `toolu_b` with `is_error: true`, no `toolUseResult`, no timestamp, content "test result: FAILED. 38 passed; 2 failed"; an assistant `tool_use` AskUserQuestion (`id: "toolu_q"`) with one question, header "Sync strategy", `multiSelect: false`, 3 options. Add a final line that is not JSON: `{"type":"assistant",`.

- [ ] **Step 2: Write the failing tests** in `#[cfg(test)] mod tests` in `insight_parse.rs`, loading the fixture with `include_str!("../tests/insight_claude_fixture.jsonl")`:
  - `skips_unknown_and_wrapper_records`: lines 0 and 2 and the malformed last line return `vec![]`.
  - `parses_user_prompt`: line 1 is `[UserPrompt { text: "fix the sync test", .. }]`.
  - `parses_text_and_usage`: line 3 yields `AssistantText` then `Usage { message_id: "msg_1", input_tokens: 15, output_tokens: 7, .. }`.
  - `parses_tool_use_target_without_input`: line 4 is `ToolUse { name: "Edit", target: Some("src/a.rs"), input: None, .. }`.
  - `counts_structured_patch_lines`: line 5 is `ToolResult { tool_use_id: "toolu_e", lines_added: Some(2), lines_removed: Some(1), is_error: false, .. }`.
  - `bash_error_result_without_tool_use_result`: line 7 has `is_error: true`, `ts: None`, `lines_added: None`, text contains `38 passed`.
  - `ask_user_question_keeps_input`: line 8 `input` is `Some(v)` with `v["questions"][0]["header"] == "Sync strategy"`.
  - `clip_result_text_keeps_head_and_tail`: a 10 000-char input returns a string that starts with the first 1024 chars, ends with the last 3072 chars, and contains `"\n...\n"`.

- [ ] **Step 3: Run to verify failure.** `cargo test --locked insight_parse` - Expected: compile error, `parse_claude_line` not found.
- [ ] **Step 4: Implement** `InsightRecord`, `parse_claude_line`, `clip_result_text` per the rules above. Use `serde_json::from_str::<Value>` and `.get()` chains; no `unwrap` on input data. Clip on char boundaries.
- [ ] **Step 5: Run to verify pass.** `cargo test --locked insight_parse` - Expected: 8 passed.
- [ ] **Step 6: Commit.** `git add src-tauri/src/insight_parse.rs src-tauri/tests/insight_claude_fixture.jsonl src-tauri/src/main.rs; git commit -m "feat(insight): parse Claude transcript lines into insight records"`

### Task 2: Codex line parser

**Files:**
- Modify: `src-tauri/src/insight_parse.rs`
- Create: `src-tauri/tests/insight_codex_fixture.jsonl`

**Interfaces:**
- Consumes: `InsightRecord`, `clip_result_text` (Task 1).
- Produces: `pub fn parse_codex_line(line: &str) -> Vec<InsightRecord>`.

Rules (verified against a real rollout on 2026-11-05):
- `response_item` with `payload.type == "message"`: `role == "user"` with joined `input_text` text not starting with `<` -> `UserPrompt`; `role == "assistant"` joined `output_text` -> `AssistantText`; `developer`/`system` roles -> nothing.
- `payload.type` `function_call` or `custom_tool_call` -> `ToolUse { id: call_id, name, target, input: None }`. `target`: for `function_call` parse `arguments` (a JSON string) and use the same key list as Task 1 plus `cmd`; for `custom_tool_call` use the first line of `input` truncated to 300 chars.
- `function_call_output` / `custom_tool_call_output` -> `ToolResult { tool_use_id: call_id, is_error: false, text, lines_added: None, lines_removed: None }`; `text` = `output` string or joined `text` of an `output` array, clipped. Codex has no reliable error flag, so `is_error` stays false.
- `event_msg` with `payload.type == "token_count"` and `info.last_token_usage` -> `Usage { message_id: <top-level timestamp>, input_tokens, output_tokens }`.
- Everything else (`session_meta`, `turn_context`, `world_state`, `reasoning`, other `event_msg`) -> nothing.

- [ ] **Step 1: Write the fixture** with one line per case: `session_meta`; developer message; user message "add a browser"; `custom_tool_call` (`call_id: "c1"`, `name: "exec"`, input `"const r = await tools.exec_command({cmd: \"ls\"})\nreturn r"`); `custom_tool_call_output` for `c1` with array output; `function_call` (`call_id: "c2"`, `name: "shell"`, `arguments: "{\"cmd\":\"cargo test\"}"`); `function_call_output` for `c2` (string); `token_count` with `last_token_usage {input_tokens: 100, output_tokens: 20}`; assistant message "Done.".
- [ ] **Step 2: Write the failing tests** `codex_skips_meta_and_developer`, `codex_user_and_assistant_text`, `codex_custom_tool_call_target_is_first_line` (target `const r = await tools.exec_command({cmd: "ls"})`), `codex_function_call_target_from_arguments` (target `cargo test`), `codex_outputs_map_to_results`, `codex_token_count_to_usage`.
- [ ] **Step 3: Run** `cargo test --locked insight_parse::tests::codex` - Expected: FAIL (function missing).
- [ ] **Step 4: Implement** `parse_codex_line`.
- [ ] **Step 5: Run** - Expected: 6 passed.
- [ ] **Step 6: Commit** `feat(insight): parse Codex rollout lines into insight records`.

### Task 3: Transcript lookup and byte-offset tailer

**Files:**
- Modify: `src-tauri/src/session_provider.rs`, `src-tauri/src/claude_session.rs`, `src-tauri/src/codex_session.rs`
- Create: `src-tauri/src/insight.rs` (+ `mod insight;` in `main.rs`)

**Interfaces:**
- Consumes: `parse_claude_line`, `parse_codex_line`, `InsightRecord`.
- Produces:

```rust
// session_provider.rs, on trait SessionProvider (default impls so other agents compile unchanged):
fn supports_transcript(&self) -> bool { false }
fn transcript_path(&self, _cwd: &str, _session_id: &str) -> Option<PathBuf> { None }
// codex_session.rs:
pub(crate) fn find_rollout_by_session_id(session_id: &str) -> Option<PathBuf>; // walk_rollout_files + read_session_meta, newest first
// insight.rs:
pub const INITIAL_TAIL_BYTES: u64 = 4 * 1024 * 1024;
pub struct TailState { pub path: PathBuf, offset: u64, carry: String, started: bool }
pub struct TailPoll { pub lines: Vec<String>, pub reset: bool }
impl TailState {
    pub fn new(path: PathBuf) -> Self;
    pub fn poll(&mut self) -> std::io::Result<TailPoll>;
}
```

`poll` behaviour: missing file -> empty poll, no error. First poll: if file len > `INITIAL_TAIL_BYTES`, seek to `len - INITIAL_TAIL_BYTES` and drop text up to and including the first `\n`. File shorter than `offset` (truncated/rewritten) -> restart from 0 with `reset: true`. Read to EOF, prepend `carry`, split on `\n`, keep the last piece (no trailing newline yet) as the new `carry`, trim `\r`, skip empty lines. Read raw bytes and decode with `String::from_utf8_lossy` only per complete line, so a UTF-8 sequence split across polls survives (keep `carry` as `Vec<u8>` if that is simpler; the field type is the implementer's call).

Claude provider: `supports_transcript` true, `transcript_path` = `claude_session::session_file_path(cwd, id)`. Codex provider: true, `find_rollout_by_session_id(id)`.

- [ ] **Step 1: Write the failing tests** in `insight.rs` using `tempfile::tempdir()`:
  - `reads_complete_lines_and_advances`: write `a\nb\n`, poll -> `["a","b"]`; poll again -> `[]`.
  - `partial_line_is_carried_to_next_poll`: write `{"x":` , poll -> `[]`; append `1}\n`, poll -> `["{\"x\":1}"]`.
  - `initial_attach_reads_only_tail_window`: write `INITIAL_TAIL_BYTES + 10_000` bytes of 100-byte lines, poll -> first returned line is a full 99-char line, total lines == `INITIAL_TAIL_BYTES / 100` (+/- 1).
  - `truncated_file_resets`: write 3 lines, poll; rewrite file with 1 line, poll -> `reset: true`, lines `== [that line]`.
  - `missing_file_is_empty_not_error`.
  - `crlf_is_trimmed`.
  - In `codex_session.rs` tests (reuse `write_rollout` and the env override): `find_rollout_by_session_id_matches_meta`.
- [ ] **Step 2: Run** `cargo test --locked insight::tests codex_session` - Expected: FAIL (missing items).
- [ ] **Step 3: Implement** the trait methods, `find_rollout_by_session_id`, `TailState`.
- [ ] **Step 4: Run** - Expected: all pass.
- [ ] **Step 5: Commit** `feat(insight): byte-offset transcript tailer and per-agent transcript lookup`.

### Task 4: Tailer task, commands, and the per-session flag (Rust)

**Files:**
- Modify: `src-tauri/src/insight.rs`, `src-tauri/src/terminal.rs` (struct `:11-45`, literals `:650`, `:828`, `:952`, test literals `:1333`, `:1700`), `src-tauri/src/database.rs` (test literal `:2233`), `src-tauri/src/commands.rs` (`CreateTerminalRequest` `:388-427`, new commands near `update_terminal_nickname` `:900`), `src-tauri/src/main.rs` (register at `:214`)

**Interfaces:**
- Consumes: `TailState`, parsers, `session_provider::provider_for`.
- Produces (frontend relies on these exact names):
  - `TerminalConfig.insight_layer: bool` with `#[serde(default)]`; `CreateTerminalRequest.insight_layer: bool` with `#[serde(default)]`, copied onto the new config.
  - Command `set_terminal_insight_layer(id: String, enabled: bool) -> Result<(), String>` (manager setter `TerminalManager::set_insight_layer`, copy `update_nickname`).
  - Command `insight_start(id: String) -> Result<InsightSupport, String>` where `#[derive(Serialize)] pub struct InsightSupport { pub supported: bool }`. Idempotent: stops an existing tailer for `id` first.
  - Command `insight_stop(id: String) -> Result<(), String>`.
  - Event `insight-records` with payload `#[derive(Serialize, Clone)] struct InsightBatch { id: String, records: Vec<InsightRecord>, reset: bool }`.

Loop design (copy the session-id detector pattern at `commands.rs:634-714`): registry `static TAILERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>>` (model: race-check registry `races.rs:896`). The spawned `tokio` task sleeps 500 ms per tick, exits when its stop flag is set or the terminal is gone from `state.terminals`. Each tick it reads `agent`, `claude_session_id`, `working_directory` from the config under the lock, releases the lock, resolves `transcript_path` (no session id yet -> skip tick). Path differs from the current `TailState.path` -> new `TailState`, next batch has `reset: true`. Parse lines with the agent's parser, emit in batches of at most 500 records. IO errors go to `error_reporter::report_bg("insight_tail", ...)` once per tailer, then the tick is skipped. File reads happen in `tokio::task::spawn_blocking` or with the lock released; never hold `state.terminals` across IO. `close_terminal` also calls `insight::stop(&id)`.

The tick logic that decides reset vs. continue is a pure function so it can be tested without Tauri:

```rust
pub(crate) fn next_tail(current: Option<TailState>, resolved: Option<PathBuf>) -> (Option<TailState>, bool /* reset */);
```

- [ ] **Step 1: Write the failing tests:** `tailer_resets_when_path_changes` (`next_tail(Some(state_a), Some(path_b))` -> state for `b`, reset true), `tailer_keeps_state_for_same_path` (reset false, offset kept), `tailer_drops_state_when_path_unresolved` (`None` -> `(None, false)`... then a later `Some(path)` gives reset true), plus `insight_layer_defaults_false_for_old_rows`: deserialize a `TerminalConfig` JSON without the field -> `insight_layer == false`.
- [ ] **Step 2: Run** `cargo test --locked insight` - Expected: FAIL.
- [ ] **Step 3: Implement** field, setter, request field, commands (each body inside `wrap_cmd`; unknown terminal id is `user_err`), registry, loop, `close_terminal` hook. `insight_start` for an agent whose provider has `supports_transcript() == false` returns `{ supported: false }` and starts nothing.
- [ ] **Step 4: Run** `cargo test --locked` then `cargo clippy` - Expected: all pass, no new clippy warnings.
- [ ] **Step 5: Commit** `feat(insight): per-terminal transcript tailer, insight_start/stop, insight_layer flag`.

### Task 5: Frontend flag, restore, global default, toggle controls

**Files:**
- Modify: `src/store/terminalStore.ts` (`TerminalConfig` `:102-129`, `CreateTerminalOptions` `:137`, new setter next to `updateNickname` `:537`), `src/store/appStore.ts` (`SavedTerminalConfig` `:565`, new setting modeled on `costTrackingEnabled` `:117/:120/:641/:870/:1451`), `src/store/appStore.test.ts` (`PERSISTED_KEYS` `:378`), `src/App.tsx` (restore `:950`), `src/components/TerminalStatusBar.tsx` (right cluster `:140-199`), `src/components/CommandPalette.tsx` (`actions` `:169-197`), `src/hooks/useKeyboardShortcuts.ts`, `src/lib/keymap.ts` (`KEYMAP` `:34-63`), `src/components/settings/categories/TerminalBehaviorPage.tsx`
- Test: `src/store/terminalStore.test.ts` (or the existing store test file), `src/components/TerminalStatusBar.test.tsx`

**Interfaces:**
- Consumes: `set_terminal_insight_layer`, `CreateTerminalRequest.insight_layer` (Task 4).
- Produces:
  - `TerminalConfig.insight_layer?: boolean`, `SavedTerminalConfig.insight_layer?: boolean`, `CreateTerminalOptions.insightLayer?: boolean`.
  - `useTerminalStore.getState().setInsightLayer(id: string, enabled: boolean): Promise<void>` (invoke, then immutable Map update; on failure `toast.error` + `reportInvokeFailure('set_terminal_insight_layer', err)`).
  - `toggleInsightLayer(id: string): void` exported from `src/lib/insightToggle.ts` (reads current flag, calls `setInsightLayer`). Status bar, palette and shortcut all call this.
  - App setting `insightLayerDefault: boolean` (default `false`) + `setInsightLayerDefault`. `createTerminal` sends `insight_layer: options.insightLayer ?? useAppStore.getState().insightLayerDefault`.
  - Shortcut **Ctrl+Shift+L** (free per the current map), acts on the active terminal; `KEYMAP` label "Toggle insight layer".

Restore: `App.tsx:950` passes `insightLayer: saved.insight_layer ?? false` so a restored session keeps its own flag and ignores the global default.

Toggle hidden for shell terminals and script children (`isShellTerminal`, `scriptParentId`).

- [ ] **Step 1: Write failing tests:** `createTerminal sends insight_layer from the global default` (mock `invoke`, set `insightLayerDefault: true`, assert payload `insight_layer: true`); `explicit insightLayer option wins over the default` (`insightLayer: false` with default true -> false); `setInsightLayer updates the config` ; status bar test `insight toggle reflects and flips the flag` (render with `insight_layer: false`, button has `aria-pressed="false"` and `aria-label="Insight layer"`, click -> invoke called with `{ id, enabled: true }`); `insight toggle is hidden for shell terminals`. Add `insightLayerDefault` to `PERSISTED_KEYS`.
- [ ] **Step 2: Run** `npx vitest run src/store src/components/TerminalStatusBar.test.tsx` - Expected: FAIL.
- [ ] **Step 3: Implement** store fields, setter, `insightToggle.ts`, status bar button (lucide `Layers`, `w-7 h-7`, inside `Tooltip` "Insight layer (Ctrl+Shift+L)", accent tint when on), palette action "Toggle insight layer" (only when an active non-shell terminal exists), shortcut, `KEYMAP` entry, settings row "New sessions start with insight layer on" with `registerSetting`.
- [ ] **Step 4: Run** `npx vitest run` on those files, then `npx tsc --noEmit` - Expected: pass.
- [ ] **Step 5: Commit** `feat(insight): per-session insight layer flag, restore, default setting, toggle controls`.

### Task 6: insightModel (records to turns)

**Files:**
- Create: `src/lib/insightModel.ts`, `src/lib/insightModel.test.ts`

**Interfaces:**
- Consumes: the `InsightRecord` wire shape from Task 1 (mirror it as a TS discriminated union on `kind`, snake_case fields).
- Produces:

```ts
export type InsightRecord = /* mirror of Rust enum */;
export type ToolCategory = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'agent' | 'other';
export interface ToolCall { id: string; name: string; category: ToolCategory; target: string | null; status: 'pending' | 'ok' | 'error'; resultText: string | null }
export interface FileTouch { path: string; added: number; removed: number; edits: number }
export interface CommandRun { toolUseId: string; command: string; status: 'pending' | 'ok' | 'error' }
export interface TurnError { toolUseId: string; toolName: string; message: string }
export interface TestCounts { passed: number; failed: number }
export interface AskOption { label: string; description: string; preview?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface PendingQuestion { toolUseId: string; questions: AskQuestion[] }
export interface InsightTurn { index: number; prompt: string; startedAt: string | null; endedAt: string | null; durationMs: number | null; headline: string; finalText: string; tools: ToolCall[]; activity: Record<ToolCategory, number>; files: FileTouch[]; commands: CommandRun[]; tests: TestCounts | null; errors: TurnError[]; tokens: number }
export interface InsightModel { turns: InsightTurn[]; pendingQuestion: PendingQuestion | null }
export type HeadlineProvider = (turn: InsightTurn) => string; // hook for a future LLM summary
export const defaultHeadline: HeadlineProvider;
export function buildInsightModel(records: InsightRecord[], headline?: HeadlineProvider): InsightModel;
export function toolCategory(name: string): ToolCategory;
export function parseTestCounts(text: string): TestCounts | null;
export function headlineFrom(text: string, max?: number): string;
export const MAX_TURNS = 50;
```

Decisions:
- A turn starts at each `user_prompt`. Records before the first prompt (attached mid-file) form a turn with prompt `"(earlier in this session)"`.
- `turns` is newest first, at most `MAX_TURNS`; `index` is 1-based from the oldest kept turn.
- `toolCategory`: read = `Read`, `NotebookRead`; edit = `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `apply_patch`; bash = `Bash`, `PowerShell`, `shell`, `exec`, `exec_command`; search = `Grep`, `Glob`, `LS`, `ToolSearch`; web = `WebFetch`, `WebSearch`; agent = `Agent`, `Task`; else other. `mcp__*` is other.
- Files: edit-category tools with a `target`, grouped by path; `added`/`removed` summed from the matching result's line counts.
- Commands: bash-category tools; `status` from result (`is_error` -> error).
- Tests: `parseTestCounts` on every bash result, last non-null in the turn wins. Patterns: cargo `test result: (ok|FAILED)\. (\d+) passed; (\d+) failed`; vitest `Tests\s+(?:(\d+) failed \| )?(\d+) passed`; jest `Tests:\s+(?:(\d+) failed, )?(\d+) passed`; pytest `=+ (?:(\d+) failed, )?(\d+) passed`. Unmatched -> null.
- Errors: every `tool_result` with `is_error`; `message` = first non-empty line of its text, max 200 chars.
- Tokens: sum `input_tokens + output_tokens` over `usage` records with a unique `message_id` inside the turn.
- Duration: last `ts` minus first `ts` in the turn; null if fewer than two timestamps.
- `finalText` = last `assistant_text` in the turn. `headlineFrom`: strip markdown markers (`#`, `*`, `` ` ``, `>`, list bullets), first sentence or line, trimmed to `max` (default 100) with a trailing `...` when cut. Empty -> `"Working..."` if the turn has pending tools, else `"(no reply)"`.
- `pendingQuestion`: the newest `AskUserQuestion` `tool_use` with no `tool_result` for its id anywhere later; parse `input.questions` defensively (skip malformed questions; null if none valid).

- [ ] **Step 1: Write failing tests** (build records inline with small helpers): `splits turns at user prompts, newest first`; `records before first prompt form an earlier turn`; `caps at 50 turns`; `categorizes tools` (table test over the name lists above); `aggregates files touched with line counts`; `marks commands ok and error`; `parses test counts` (one case per pattern: cargo `38 passed; 2 failed` -> `{passed: 38, failed: 2}`, vitest `Tests  12 passed (12)` -> `{12, 0}`, jest `Tests: 1 failed, 4 passed` -> `{4, 1}`, pytest `==== 2 failed, 10 passed in 1.2s` -> `{10, 2}`, unrelated text -> null); `collects errors with first line`; `dedupes usage by message id`; `computes duration from timestamps`; `headline strips markdown and truncates`; `pending question present until its result arrives`; `malformed question input yields null`.
- [ ] **Step 2: Run** `npx vitest run src/lib/insightModel.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - Expected: PASS.
- [ ] **Step 5: Commit** `feat(insight): insightModel folds transcript records into per-turn digests`.

### Task 7: Question answer keys (verify against the live TUI first)

**Files:**
- Create: `src/lib/questionKeys.ts`, `src/lib/questionKeys.test.ts`
- Modify: `src/store/terminalStore.ts` (add `sendKeySequence`)

**Interfaces:**
- Consumes: `AskQuestion` (Task 6), `writeToTerminal(id, data)` (`terminalStore.ts:550`).
- Produces:

```ts
export interface QuestionAnswer { selected: number[]; other: string | null } // indexes into options
export function buildAnswerKeys(questions: AskQuestion[], answers: QuestionAnswer[]): string[]; // one PTY write per element
// terminalStore:
sendKeySequence(id: string, keys: string[], gapMs?: number): Promise<void>; // default gapMs 40, writes each element via writeToTerminal
```

- [ ] **Step 1: Verify the key sequence in the live Claude Code TUI.** Use the `/qa` skill to start an isolated instance, open a Claude session, and prompt it: "Use AskUserQuestion to ask me two questions: one single-select with 3 options, one multiSelect with 3 options." Record, for the installed Claude Code version (`claude --version`): (a) whether a digit key selects and advances, or only arrows + Enter; (b) the row index of the free-text "Other"/"Type something" row; (c) how multi-select toggles (Space or Enter) and how it advances; (d) whether a final "Submit answers" review screen appears and which key confirms it; (e) whether xterm is in application cursor mode (Down = `\x1bOB` vs `\x1b[B`). Write the findings as a comment block at the top of `questionKeys.ts` with the Claude Code version. If computer-use is not available to drive the window, ask the user to perform these five checks and paste the answers.
- [ ] **Step 2: Write failing tests** pinned to the verified behaviour. Required cases: `single select second option`; `other answer types text and submits`; `other text newlines become spaces` (`"a\nb"` -> typed `"a b"`); `multi select toggles each chosen option then advances`; `two questions produce one key group per question plus the final confirm`; `answers length mismatch throws`.
- [ ] **Step 3: Run** `npx vitest run src/lib/questionKeys.test.ts` - Expected: FAIL.
- [ ] **Step 4: Implement** `buildAnswerKeys` and `sendKeySequence` (sequential awaits; a key group never contains `\r` mixed with text so `writeToTerminal`'s submit marker fires only on the real Enter).
- [ ] **Step 5: Run** - Expected: PASS.
- [ ] **Step 6: Commit** `feat(insight): build Claude Code TUI key sequences for question answers`.

### Task 8: insightStore and useInsightFeed

**Files:**
- Create: `src/store/insightStore.ts`, `src/hooks/useInsightFeed.ts`, `src/hooks/useInsightFeed.test.ts`
- Modify: `src/store/terminalStore.ts` (`closeTerminal` cleanup `:~400-436`: call `useInsightStore.getState().clear(id)`)

**Interfaces:**
- Consumes: commands `insight_start` / `insight_stop`, event `insight-records` (Task 4), `InsightRecord` (Task 6).
- Produces:

```ts
export const MAX_RECORDS = 5000;
interface InsightTerminalState { records: InsightRecord[]; supported: boolean | null; heightPx: number | null; collapsed: boolean | null; expandedTurn: number | null }
useInsightStore: { byId: Map<string, InsightTerminalState>; append(id, records, reset): void; setSupported(id, v): void; setHeight(id, px): void; setCollapsed(id, v): void; setExpandedTurn(id, idx | null): void; clear(id): void }
export function useInsightFeed(terminalId: string, enabled: boolean): void;
export function useInsightModel(terminalId: string): InsightModel; // memoized buildInsightModel over records
```

`append` with `reset: true` replaces records; otherwise concatenates and keeps the last `MAX_RECORDS`. `useInsightFeed`: when `enabled`, `listen('insight-records')` filtered by `id`, buffer incoming batches, flush to the store at most every 300 ms (a single `setTimeout`, a reset inside the buffer drops earlier buffered batches), then `invoke('insight_start', { id })` and store `supported`. On disable/unmount: unlisten, clear the timer, `invoke('insight_stop', { id }).catch(() => {})` (best-effort: the Rust loop also exits when the terminal closes). When `enabled` is false the hook does nothing at all.

- [ ] **Step 1: Write failing tests** (mock `@tauri-apps/api/event` `listen` and `core` `invoke`, fake timers): `does nothing when disabled` (no listen, no invoke); `starts and stops the tailer`; `throttles flushes to 300 ms` (3 events within 100 ms -> one store update after 300 ms); `ignores other terminal ids`; `reset replaces records`; `caps stored records at 5000`.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useInsightFeed.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - Expected: PASS.
- [ ] **Step 5: Commit** `feat(insight): insight store and throttled transcript feed hook`.

### Task 9: Structured results, charts, mini markdown

**Files:**
- Create: `src/lib/structuredOutput.ts`, `src/lib/structuredOutput.test.ts`, `src/components/insight/charts.tsx`, `src/components/insight/MiniMarkdown.tsx`, `src/components/insight/StructuredResult.tsx`, `src/components/insight/StructuredResult.test.tsx`

**Interfaces:**
- Produces:

```ts
export type StructuredBlock =
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'bars'; items: { label: string; value: number }[] }
  | { kind: 'line'; points: number[] }
  | { kind: 'markdown'; text: string };
export function detectStructured(text: string): StructuredBlock[];
// charts.tsx
export function BarChart(props: { items: { label: string; value: number }[]; max?: number }): JSX.Element;
export function LineChart(props: { points: number[] }): JSX.Element;
// StructuredResult.tsx
export function StructuredResult(props: { text: string }): JSX.Element;
```

Detection (conservative; anything unsure stays markdown, in document order):
- Markdown table: a line with at least 2 `|`, followed by a separator line matching `^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$`, then rows until a line without `|`. Cap 200 rows.
- Fenced ```` ```json ```` block that parses to: an array of flat objects with at most 8 keys -> table; an array of at least 5 numbers -> line; an array of 3-4 numbers -> bars labelled `1..n`; an object whose values are all numbers (at least 2) -> bars. Parse failure -> markdown.
- At least 3 consecutive lines matching `^\s*[-*]\s+(.+?):\s*(-?\d+(?:\.\d+)?)\s*%?\s*$` -> bars.
- Bars capped at 20 items; negative values render from a zero baseline.

`charts.tsx`: plain SVG with `viewBox`, colors from CSS vars (`var(--accent-primary)`, text tokens), value labels as `<text>`, `role="img"` and an `aria-label` summarizing the data. `MiniMarkdown`: paragraphs, `#` headings, `-`/`1.` lists, `**bold**`, `` `code` ``, fenced code; React elements only, never `dangerouslySetInnerHTML`.

- [ ] **Step 1: Write failing tests:** `detects markdown table`; `pipe text without separator stays markdown`; `json array of objects becomes table`; `json numbers object becomes bars`; `json number series becomes line`; `invalid json stays markdown`; `label: number list becomes bars`; `keeps document order of mixed blocks`; component test `renders table and bar chart` (text with one table and one list -> a `<table>` with header cells and an `svg[role=img]`).
- [ ] **Step 2: Run** `npx vitest run src/lib/structuredOutput.test.ts src/components/insight/StructuredResult.test.tsx` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - Expected: PASS.
- [ ] **Step 5: Commit** `feat(insight): conservative table and chart rendering for structured output`.

### Task 10: QuestionBox

**Files:**
- Create: `src/components/insight/QuestionBox.tsx`, `src/components/insight/QuestionBox.test.tsx`

**Interfaces:**
- Consumes: `PendingQuestion` (Task 6), `buildAnswerKeys`, `sendKeySequence` (Task 7), `terminalStates` from `terminalStore`, `BarChart` (Task 9), `MiniMarkdown`.
- Produces: `export function QuestionBox(props: { terminalId: string; pending: PendingQuestion }): JSX.Element | null`.

Behaviour:
- Renders only while the terminal's `SessionState` is `'waiting'` (else returns null). One section per question: header chip, question text, options as cards side by side (wrap on narrow widths), description under the label, `preview` rendered in a `<pre>` via `MiniMarkdown` when present, `(Recommended)` label suffix shown as a chip. Selected card has a 2px accent border. Multi-select uses toggle cards with `aria-pressed`; single-select uses `role="radio"` cards in a `role="radiogroup"`. "Other answer" text input per question.
- Numeric comparison: if every option's description contains exactly one number with the same unit (`%`, `MB`, `ms`, `s`, or none), render a `BarChart` of those values under the cards. Otherwise no chart.
- "Answer" button (Enter inside the box also submits) is disabled until every question has a selection or other text. On submit: re-read the store; if the pending `toolUseId` is no longer pending or the state is not `'waiting'`, do nothing. Else `sendKeySequence(id, buildAnswerKeys(...))`, then mark the box as sent (spinner) until the tool result removes it. Failure -> `toast.error` + `reportInvokeFailure('write_to_terminal', err)`.
- No autofocus. Esc inside the box calls the terminal's `xterm.focus()`.
- Attention: no new trigger. The existing poller already raises attention for the TUI menu; Task 12 pins that with a test.

- [ ] **Step 1: Write failing tests:** `renders header, question and option cards`; `hidden when session is not waiting`; `single select then Answer sends the built keys` (mock `sendKeySequence`, assert called with `buildAnswerKeys(questions, [{selected: [1], other: null}])`); `other text answer`; `multi select toggles`; `answer disabled until every question is answered`; `does not send when the question is no longer pending` (change store records so the result exists before clicking); `renders comparison chart when options share a numeric unit`; `Esc returns focus to the terminal`.
- [ ] **Step 2: Run** `npx vitest run src/components/insight/QuestionBox.test.tsx` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - Expected: PASS.
- [ ] **Step 5: Commit** `feat(insight): clickable question box that answers through the PTY`.

### Task 11: InsightLayer panel and TerminalView integration

**Files:**
- Create: `src/components/insight/InsightLayer.tsx`, `TurnDigest.tsx`, `StatTiles.tsx`, `ActivityBars.tsx`, `FilesTouched.tsx`, `InsightCollapsedBar.tsx`, `InsightLayer.test.tsx`
- Modify: `src/components/TerminalView.tsx` (mount between `<TerminalSearch>` `:632` and the xterm container `:637`)

**Interfaces:**
- Consumes: `useInsightFeed`, `useInsightModel`, `useInsightStore` (Task 8), `QuestionBox` (Task 10), `StructuredResult` (Task 9), `useAppStore.openFileTab` / `requestEditorNavigation` / `openDiffTab`, `terminalMetrics`, `terminalStates`.
- Produces: `export function InsightLayer(props: { terminalId: string }): JSX.Element`, plus `export function findLineInBuffer(xterm: Terminal, needle: string): number | null` in `src/lib/insightJump.ts` (scans the active buffer bottom-up for the first line containing `needle`, returns the absolute line or null).

Mounting: `TerminalView` renders `<InsightLayer>` only when `config.insight_layer` is true and the terminal is neither a shell nor a script child. That is what makes "off" cost nothing: no hook, no listener, no tailer.

Layout and behaviour:
- Expanded: panel with `max-height` set by `heightPx` (default 40% of the pane, min 120 px, max 70%), its own scroll, and a drag handle (`role="separator"`, `aria-orientation="horizontal"`, keyboard Up/Down by 16 px) at the bottom. After drag ends, the xterm container resizes; confirm the existing fit/ResizeObserver path re-fits, and call it explicitly if not.
- Collapsed: `InsightCollapsedBar`, 28 px, latest headline plus a "Question" badge when `pendingQuestion` is set. Click expands. A `ResizeObserver` on the pane: when height < 360 px and the user has not chosen (`collapsed === null`), render collapsed. This covers small grid cells.
- Order inside: `QuestionBox` (when pending), newest turn expanded as `TurnDigest`, older turns as one-line rows (`> Turn N: headline`) that expand on click (`expandedTurn`).
- `TurnDigest`: headline + duration; `StatTiles` (files changed, commands run, tests passed, tests failed, errors, tokens, plus session cost from `terminalMetrics.costUsd` when present; tiles with no data are omitted); `ActivityBars` (horizontal bars per non-zero `ToolCategory`); `FilesTouched` (path, `+added` / `-removed`; click opens `openFileTab(absPath)`; a diff icon calls `openDiffTab` when the repo root is known from the terminal's git info, else hidden); error strip with "Jump to output" that runs `findLineInBuffer` on the first 60 chars of the message and `xterm.scrollToLine`, or toasts "Not found in the terminal output" when null; `StructuredResult` on `finalText`.
- Relative file paths resolve against `config.working_directory`.
- `supported === false`: show the fallback body (Task 12) instead of turns. `supported === true` with no records: "Waiting for the session transcript...".
- No list virtualization: turns are capped at 50 and older ones render as one-line rows, which is cheap (plan author's call; revisit if profiling says otherwise).
- Focus: nothing in the layer takes focus on mount or update. `Esc` anywhere in the layer focuses xterm.

- [ ] **Step 1: Write failing tests** (seed `useInsightStore` and `useTerminalStore`, mock `invoke`/`listen`): `renders newest turn digest with stat tiles`; `older turns are collapsed rows and expand on click`; `file click opens the editor tab`; `jump to output scrolls xterm` (mock xterm with a buffer containing the line, expect `scrollToLine` called with its index); `collapsed bar shows headline and question badge`; `starts collapsed in a short pane`; `does not steal focus on update`; `TerminalView does not mount the layer when insight_layer is false` (assert `invoke` never called with `insight_start`).
- [ ] **Step 2: Run** `npx vitest run src/components/insight` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** - Expected: PASS. Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(insight): insight layer panel above the terminal output`.

### Task 12: Fallback for agents without transcripts, and the attention check

**Files:**
- Modify: `src/lib/terminalState.ts` (extract `hasOptionMenu(lines): boolean` from `classifySettled`, no behaviour change), `src/components/insight/InsightLayer.tsx`
- Test: `src/lib/terminalState.test.ts`, `src/components/insight/InsightLayer.test.tsx`

**Interfaces:**
- Produces: `export function hasOptionMenu(lines: string[]): boolean`.

Fallback body: the session state chip (`busy` / `waiting` / `idle` / `stopped`), "An option menu is open in the terminal" when `waiting` and `hasOptionMenu(readBufferTail(...))`, and the fixed text "No structured data for this agent". No guessed digests.

- [ ] **Step 1: Write failing tests:** `hasOptionMenu detects a numbered menu with a cursor`; `classifySettled is unchanged` (existing tests stay green); `classifies the Claude AskUserQuestion screen as waiting` (fixture: the buffer lines captured during Task 7 Step 1, pasted as a string array); component test `shows the no-structured-data fallback when unsupported`.
- [ ] **Step 2: Run** `npx vitest run src/lib/terminalState.test.ts src/components/insight` - Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** If the AskUserQuestion screen is not classified as `waiting`, extend `OPTION_LINE` / `WAITING_PATTERNS` minimally to cover it, since attention must fire the same way as for any waiting session.
- [ ] **Step 4: Run** - Expected: PASS.
- [ ] **Step 5: Commit** `feat(insight): fallback view for agents without transcripts`.

### Task 13: Full verification and manual QA

- [ ] **Step 1:** `npx tsc --noEmit` - Expected: no errors.
- [ ] **Step 2:** `npm run test:run` - Expected: all pass.
- [ ] **Step 3:** `cd src-tauri; cargo test --locked; cargo clippy` - Expected: all pass, no new warnings.
- [ ] **Step 4:** `/qa` isolated instance. Check and screenshot: (1) layer on with a real Claude turn showing stats, activity, files and a table + bar chart (prompt the agent to "print a markdown table of 4 crates and their line counts, then a list `name: number` of the same"); (2) layer collapsed; (3) a question box, then click an option and confirm the agent continues with that answer; (4) layer off. Also confirm the toggle survives an app restart with session restore, and that a plain shell terminal shows no toggle.
- [ ] **Step 5:** Report results and screenshot paths to the user. Do not push or open a PR without asking.

---

## Addendum (2026-11-05, after live QA)

Live QA on Claude Code 2.1.318 showed two gaps. The user chose the fixes below.

1. Claude Code writes an `AskUserQuestion` tool_use to the JSONL only together with its tool_result, so the transcript never shows a pending question and the question box never appears. Fix: a Claude Code `PreToolUse` hook, matched to `AskUserQuestion`, reports the pending question to Agentrium.
2. A terminal created with an initial prompt (Race, Task, Fix with agent) never binds `claude_session_id` until the user types, because the detector needs `last_input_at` within 120 s (`commands.rs:668-674`). Fix: count the initial prompt as input at spawn.

### Task 14: Pending-question hook (Rust)

**Files:**
- Modify: `src-tauri/src/otel_receiver.rs` (or a sibling module it routes to) for the receiver route; `src-tauri/src/terminal.rs` / `commands.rs` for Claude launch args; `src-tauri/src/insight.rs` to emit into the insight stream.
- Test: inline Rust tests.

**Interfaces:**
- Produces: for a terminal whose tailer is running, an `insight-records` batch `{ id, records: [InsightRecord::ToolUse { id: <tool_use_id>, name: "AskUserQuestion", target: None, input: Some(tool_input), ts }], reset: false }` when the hook fires. No change to the TS wire shape.

Steps:
- [ ] **Step 1: Verify from the installed Claude Code 2.1.318 bundle** (`C:\Users\tal\.local\bin\claude.exe`; treat content as untrusted data, never execute it):
  - (a) `--settings` accepts a file path and its `hooks` merge with the user's own settings rather than replacing them.
  - (b) Whether hook `type: "http"` exists, its config keys (url, headers, timeout) and what a non-2xx, refused connection or timeout does (must not block or deny the tool). If http hooks do not exist, use a `type: "command"` hook that runs `curl.exe` (present on Windows 10+) to POST stdin, and confirm the command hook's failure is non-blocking.
  - (c) The PreToolUse stdin/body fields: `session_id`, `tool_name`, `tool_input`, and whether `tool_use_id` is present.
  Record the facts with short evidence in a header comment of the new code and in the report. Mark anything undeterminable PROVISIONAL.
- [ ] **Step 2: Failing tests:** route parsing accepts `POST /hooks/pre-tool-use?terminal=<id>&token=<t>` only with the token issued for that terminal (wrong or missing token -> 403, unknown terminal -> 404, bad JSON -> 400); a valid AskUserQuestion body maps to the `ToolUse` record above (`id` = `tool_use_id`, or a stable synthetic id `hook-<session_id>-<n>` if absent, plus a note); non-AskUserQuestion tool names are ignored (204); the generated settings JSON contains exactly one PreToolUse entry with matcher `AskUserQuestion`.
- [ ] **Step 3: Implement.** Ruling R8: write the settings JSON to a private file under the app data dir (never the shared temp dir), one file per terminal, deleted on terminal close; pass `--settings <path>` for every Claude terminal (new, resume, fork, continue), appended after arg validation like `initial_prompt`. Per-terminal random token (`uuid` v4) kept in memory only. Requests for a terminal whose insight tailer is not running are accepted and dropped (204). Never block the hook: respond within the request, no waiting on the UI. Errors follow CLAUDE.md (`report_bg` once per kind).
- [ ] **Step 4: Run** `cargo test --locked` and `cargo clippy`.
- [ ] **Step 5: Commit** `feat(insight): pending AskUserQuestion via Claude Code PreToolUse hook`.

### Task 15: Model handles hook records

**Files:** `src/lib/insightModel.ts`, `src/lib/insightModel.test.ts`

- [ ] Tool uses with the same `id` are deduplicated (keep the first position, merge `input` if the later one has it), so the hook record and the later transcript record count once. A hook record with a synthetic id (`hook-...`) is treated as answered when any later `tool_result` or `user_prompt` arrives in the stream, or a transcript `AskUserQuestion` tool_use with a real id appears after it.
- [ ] Tests: hook record alone -> pendingQuestion set; hook record + transcript tool_use + result with the same id -> not pending and counted once in activity; synthetic-id hook record followed by a tool_result -> not pending.
- [ ] Commit `feat(insight): merge hook-reported questions with transcript records`.

### Task 16: Initial prompt counts as input for session binding

**Files:** `src-tauri/src/terminal.rs` (spawn path where `last_input_at` is initialised), test inline.

- [ ] Ruling R9: when `create_terminal` receives an `initial_prompt`, set `last_input_at = Some(now)` at spawn so the detector binds the new session file. Test: a terminal created with an initial prompt has `last_input_at` set; one without does not.
- [ ] Commit `fix(session): count the initial prompt as input for session binding`.

### Task 17: Re-run live QA for the question box

- [ ] Relaunch the QA instance (unset `CLAUDE_CODE_CHILD_SESSION` in the launching shell), ask Claude to use AskUserQuestion, confirm the box appears, click an option, confirm the agent continues with that answer, screenshot. Also start a session with an initial prompt and confirm the layer fills without typing.
