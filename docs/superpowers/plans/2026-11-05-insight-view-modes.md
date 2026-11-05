# Insight View Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-session insight on/off flag with a per-session view mode (CLI, Mixed, Insight only), where Insight only hides the terminal behind the insight layer, adds a prompt bar and status line, and slides the real terminal in as a drawer when the agent needs input the layer cannot show.

**Architecture:** Rust stores `view_mode` on `TerminalConfig` (default `cli`, old `insight_layer: true` rows load as `mixed`). The frontend keeps one source of truth per session in `terminalStore`, a pure `src/lib/viewMode.ts` decides which modes a session may use and how the shortcut cycles, and `TerminalView` renders one of three layouts. In Insight mode the xterm container fills the pane behind an opaque layer at its real size, so neither the mode switch nor the drawer ever resizes the PTY.

**Tech Stack:** Tauri 2 / Rust (serde), React 18 + TypeScript, Zustand, Tailwind, lucide-react, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-05-insight-view-modes-design.md` (builds on `docs/superpowers/specs/2026-11-05-insight-layer-design.md`).

**Worktree:** `C:\Users\tal\.agentrium-worktrees\agentrium\insight-layer`, branch `feat/insight-layer`. Rust commands from `src-tauri/`. Never run `npm run tauri dev` during implementation (its Vite watcher crashes on cargo rebuilds); never commit `src-tauri/gen/**` or `package-lock.json`.

## Global Constraints

- Three modes per session: `cli`, `mixed`, `insight`. Default for new sessions is `cli`, configurable in Settings ("Default view for new sessions"). The per-session mode always wins over the default.
- Each session remembers its mode across restart and session restore. Old rows with `insight_layer: true` open as Mixed; `false` or missing as CLI. The old setting `insightLayerDefault: true` becomes default `mixed`.
- Never shrink or resize the PTY to hide the terminal. In Insight mode the terminal stays mounted at the pane's full size behind the layer (not `display:none`).
- Shell terminals and script children: always CLI, no switch. Claude and Codex: all three modes. Cursor, Antigravity and custom agents: CLI and Mixed; Insight shown disabled with tooltip "No structured data for this agent".
- Header control is a 3-way switch CLI | Mixed | Insight where the Insight pill is now; `Ctrl+Shift+L` cycles CLI -> Mixed -> Insight -> CLI, skipping modes the session cannot use; Command Palette has "View: CLI", "View: Mixed", "View: Insight".
- The view mode is local only and never part of a sync payload.
- Repo `CLAUDE.md` rules (wrap_cmd, user_err, report_bg; frontend toast + reportInvokeFailure for user actions). No em-dash or en-dash anywhere. No new dependencies. Theme tokens and lucide icons.

## Review Focus

1. **A prompt with several lines** must arrive as one message, not be submitted line by line. Test in Task 4 (`multiline prompt is one bracketed paste then Enter`).
2. **Claude's permission prompt is classified busy** while its TUI redraws, but the drawer must still open. Test in Task 5 (`opens for the permission prompt regardless of session state`).
3. **Switching Insight <-> drawer or Mixed <-> Insight must not resize the PTY.** Test in Task 6 (`drawer open and close never call fit or resize`).
4. **Old saved sessions** with `insight_layer: true` must restore as Mixed, not CLI. Tests in Task 1 (Rust) and Task 2 (frontend restore).
5. **Shortcut on an agent without a transcript** must skip Insight. Test in Task 3 (`cycle skips insight for cursor`).

---

## File Structure

- Rust: `src-tauri/src/terminal.rs` (`ViewMode`, `TerminalConfig.view_mode`, legacy mapping, `set_view_mode`), `src-tauri/src/commands.rs` (`CreateTerminalRequest.view_mode`, `set_terminal_view_mode` replacing `set_terminal_insight_layer`), `src-tauri/src/database.rs` (apply legacy mapping on load), `src-tauri/src/main.rs` (register).
- Create `src/lib/viewMode.ts` (+ test): types and pure rules.
- Create `src/lib/promptSend.ts` (+ test): prompt keys and interrupt.
- Create `src/hooks/useTerminalDrawer.ts` (+ test): drawer state.
- Create `src/lib/restartTerminal.ts`: restart logic extracted from `TerminalStatusBar.tsx` (`handleRestart`, ~:58).
- Create `src/components/insight/ViewModeSwitch.tsx` (+ test), replacing `InsightToggleButton.tsx` (+ test, delete both).
- Create `src/components/insight/PromptBar.tsx`, `InsightStatusLine.tsx`, `InsightOnlyView.tsx` (+ tests).
- Delete `src/lib/insightToggle.ts`.
- Modify: `src/store/terminalStore.ts`, `src/store/appStore.ts` (+ test), `src/App.tsx` (restore), `src/components/TerminalTabs.tsx`, `src/components/TerminalView.tsx` (~:644), `src/components/insight/InsightLayer.tsx` (variant), `src/components/CommandPalette.tsx`, `src/hooks/useKeyboardShortcuts.ts` (+ test), `src/lib/keymap.ts`, `src/lib/terminalState.ts` (+ test), `src/components/settings/categories/TerminalBehaviorPage.tsx`, `src/components/TerminalStatusBar.tsx`.

---

### Task 1: Rust view mode with legacy mapping

**Files:** `src-tauri/src/terminal.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/database.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Produces:

```rust
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode { #[default] Cli, Mixed, Insight }
// TerminalConfig: `#[serde(default)] pub view_mode: ViewMode` replaces `insight_layer`.
// Legacy: `#[serde(default, rename = "insight_layer", skip_serializing)] legacy_insight_layer: bool`
impl TerminalConfig { pub fn apply_legacy_view_mode(&mut self); } // Cli + legacy true -> Mixed; then clears legacy
// CreateTerminalRequest: `#[serde(default)] view_mode: ViewMode` (replaces insight_layer)
// command: set_terminal_view_mode(id: String, mode: ViewMode) -> Result<(), String>  (replaces set_terminal_insight_layer)
// TerminalManager::set_view_mode(&mut self, id: &str, mode: ViewMode) -> Result<(), String>
```

`Database::load_last_session` calls `apply_legacy_view_mode` on every loaded config. The insight tailer and hook are unchanged (the frontend decides when to start the tailer).

- [ ] **Step 1: Failing tests:** `view_mode_defaults_to_cli_for_old_rows` (JSON without either field -> `Cli`); `legacy_insight_layer_true_loads_as_mixed` (JSON with `"insight_layer": true`, after `apply_legacy_view_mode` -> `Mixed`); `legacy_flag_never_overrides_explicit_mode` (`"view_mode":"insight","insight_layer":true` -> `Insight`); `view_mode_serializes_lowercase_without_legacy_field` (serialized JSON has `"view_mode":"mixed"` and no `insight_layer` key); a `database.rs` round-trip: save a config JSON row containing `insight_layer: true`, `load_last_session` returns `Mixed`.
- [ ] **Step 2: Run** `cargo test --locked view_mode` - Expected: FAIL (compile).
- [ ] **Step 3: Implement** the enum, field swap in the struct and every literal (they were updated for `insight_layer` in the previous feature; replace each), request field, setter, command (inside `wrap_cmd`, unknown id is `user_err`), registration, removal of `set_terminal_insight_layer`.
- [ ] **Step 4: Run** `cargo test --locked` and `cargo clippy` - Expected: pass, no new warnings.
- [ ] **Step 5: Commit** `feat(insight): per-session view mode replaces the insight on/off flag`.

### Task 2: Frontend view mode model, store, default, restore

**Files:** create `src/lib/viewMode.ts` + `viewMode.test.ts`; modify `src/store/terminalStore.ts` (+ test), `src/store/appStore.ts` (+ test), `src/App.tsx`, `src/components/TerminalStatusBar.tsx` (+ test), create `src/lib/restartTerminal.ts`, `src/components/settings/categories/TerminalBehaviorPage.tsx`, delete `src/lib/insightToggle.ts`.

**Interfaces:**
- Consumes: `set_terminal_view_mode { id, mode }`, `CreateTerminalRequest.view_mode` (Task 1).
- Produces:

```ts
// src/lib/viewMode.ts
export type ViewMode = 'cli' | 'mixed' | 'insight';
export const VIEW_MODES: ViewMode[] = ['cli', 'mixed', 'insight'];
export function availableViewModes(t: { isShellTerminal?: boolean; scriptParentId?: string | null; config: { agent?: AgentKind } }): ViewMode[];
//   shell or script child -> ['cli']; claude | codex -> all three; anything else -> ['cli', 'mixed']
export function nextViewMode(current: ViewMode, available: ViewMode[]): ViewMode; // cli->mixed->insight->cli, skipping unavailable
export function viewModeOf(config: { view_mode?: ViewMode; insight_layer?: boolean }): ViewMode; // view_mode ?? (insight_layer ? 'mixed' : 'cli')
// terminalStore
TerminalConfig.view_mode?: ViewMode; CreateTerminalOptions.viewMode?: ViewMode;
setViewMode(id: string, mode: ViewMode): Promise<void>;   // replaces setInsightLayer; same error handling
// createTerminal sends view_mode: options.viewMode ?? useAppStore.getState().defaultViewMode
// appStore
defaultViewMode: ViewMode (default 'cli'); setDefaultViewMode(m: ViewMode)
// persist: bump version, migrate insightLayerDefault true -> defaultViewMode 'mixed', drop insightLayerDefault
// src/lib/restartTerminal.ts
export async function restartTerminal(id: string): Promise<void>; // moved from TerminalStatusBar handleRestart, passes { viewMode }
```

Restore (`App.tsx`, the `createTerminal` call in `handleRestore`) passes `viewMode: viewModeOf(saved)`. Settings: replace the "New sessions start with insight layer on" toggle with a select "Default view for new sessions" (CLI / Mixed / Insight), `registerSetting` updated. Every remaining reference to `insight_layer` / `insightLayer` / `setInsightLayer` / `insightLayerDefault` is replaced (the `grep` list is in the File Structure section); `TerminalView` keeps mounting the panel when mode is `mixed` (Insight layout comes in Task 6).

- [ ] **Step 1: Failing tests:** `availableViewModes` table (shell, script child, claude, codex, cursor, `custom:x`); `nextViewMode` (`cli`->`mixed`, `insight`->`cli`, `mixed`->`cli` when insight unavailable); `viewModeOf` (explicit wins, legacy true -> mixed, empty -> cli); store: `createTerminal sends view_mode from the default`, `explicit viewMode option wins`, `setViewMode invokes set_terminal_view_mode and updates the config`, failure toasts and reports `set_terminal_view_mode`; appStore: `migrates insightLayerDefault true to defaultViewMode mixed`, `PERSISTED_KEYS` updated; restart test (existing, in `TerminalStatusBar.test.tsx`) now asserts `{ viewMode: 'mixed' }`.
- [ ] **Step 2: Run** `npx vitest run src/lib/viewMode.test.ts src/store src/components/TerminalStatusBar.test.tsx` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsc --noEmit` and `npm run test:run` - Expected: pass.
- [ ] **Step 5: Commit** `feat(insight): frontend view mode model, default setting and restore`.

### Task 3: Controls: header switch, palette, shortcut

**Files:** create `src/components/insight/ViewModeSwitch.tsx` + test; delete `InsightToggleButton.tsx` + test; modify `src/components/TerminalTabs.tsx`, `src/components/CommandPalette.tsx`, `src/hooks/useKeyboardShortcuts.ts` (+ test), `src/lib/keymap.ts`.

**Interfaces:**
- Consumes: `availableViewModes`, `nextViewMode`, `viewModeOf`, `setViewMode` (Task 2).
- Produces: `export function ViewModeSwitch({ terminalId }: { terminalId: string }): JSX.Element | null`.

Behaviour: segmented control with three buttons labelled "CLI", "Mixed", "Insight" (lucide `SquareTerminal`, `Columns2` or similar, `Layers`), `role="radiogroup"` with `role="radio"` / `aria-checked` segments, `aria-label="View mode"`. Unavailable segments are `aria-disabled` with tooltip "No structured data for this agent". Returns null when only `cli` is available. Placed where `InsightToggleButton` is now. Palette: three entries "View: CLI" / "View: Mixed" / "View: Insight" for the active session, only the available ones. Shortcut `Ctrl+Shift+L` (ignores `e.repeat`, as today) cycles with `nextViewMode`; keymap label "Cycle view mode".

- [ ] **Step 1: Failing tests:** `renders three segments with the current one checked`; `click Insight calls setViewMode('insight')`; `insight segment disabled for cursor`; `hidden for shell terminals`; shortcut: `cycles cli -> mixed -> insight -> cli`, `cycle skips insight for cursor`, `ignores key repeat`; palette shows only available entries.
- [ ] **Step 2: Run** `npx vitest run src/components/insight/ViewModeSwitch.test.tsx src/hooks/useKeyboardShortcuts.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsc --noEmit` and `npm run test:run` - Expected: pass.
- [ ] **Step 5: Commit** `feat(insight): view mode switch, palette entries and cycling shortcut`.

### Task 4: Prompt sending and the prompt bar

**Files:** create `src/lib/promptSend.ts` + test, `src/components/insight/PromptBar.tsx` + test; modify `src/store/insightStore.ts` (prompt history).

**Interfaces:**
- Consumes: `sendKeySequence(id, keys, gapMs?)` (terminalStore).
- Produces:

```ts
// src/lib/promptSend.ts
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export function buildPromptKeys(text: string): string[];
//   trims trailing whitespace; empty -> []; no newline -> [text, '\r']; with newline -> [PASTE_START + text + PASTE_END, '\r']
export function sendPrompt(terminalId: string, text: string): Promise<void>;   // sendKeySequence(buildPromptKeys(text))
export function interruptAgent(terminalId: string): Promise<void>;             // sendKeySequence(['\x1b'])
// insightStore additions (in memory only)
pushPromptHistory(id: string, text: string): void;   // dedupe consecutive, keep last 50
promptHistory(id: string): string[];
// src/components/insight/PromptBar.tsx
export function PromptBar(props: { terminalId: string; disabledReason: string | null; busy: boolean; onShowTerminal: () => void }): JSX.Element;
```

PromptBar: auto-growing textarea (max about 8 lines), placeholder "Message the agent", Enter sends, Shift+Enter newline, Up on the first line / Down on the last line walks history (draft kept), `/` text sent as is, Send button, Stop button visible while `busy` (also Esc in the textarea while `busy`), Show terminal button. `disabledReason` non-null -> textarea and Send disabled, text kept, reason shown as placeholder or hint. Failures: `toast.error` + `reportInvokeFailure('write_to_terminal', err)`, text restored.

- [ ] **Step 1: Failing tests:** `buildPromptKeys`: `single line is text then Enter`, `multiline prompt is one bracketed paste then Enter`, `trailing whitespace trimmed`, `empty sends nothing`, `slash command sent as is`; PromptBar: `Enter sends and clears`, `Shift+Enter inserts newline`, `Up recalls previous prompt and Down returns to draft`, `disabled keeps text and shows the reason`, `Stop sends Esc while busy`, `Esc in textarea interrupts only while busy`, `send failure restores the text and toasts`.
- [ ] **Step 2: Run** `npx vitest run src/lib/promptSend.test.ts src/components/insight/PromptBar.test.tsx` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** focused tests, then `npx tsc --noEmit` - Expected: pass.
- [ ] **Step 5: Commit** `feat(insight): prompt bar with paste-safe sending, history and stop`.

### Task 5: Drawer detection

**Files:** modify `src/lib/terminalState.ts` (+ test); create `src/hooks/useTerminalDrawer.ts` + test.

**Interfaces:**
- Consumes: `hasOptionMenu`, `WAITING_PATTERNS`, `readBufferTail` (exported from `src/hooks/useSessionStateDetection.ts`), `useSessionAttentionStore`.
- Produces:

```ts
// terminalState.ts
export function isShellPrompt(lines: string[]): boolean;  // last non-empty line is a bare shell prompt:
//   cmd  /^[A-Za-z]:\\[^>]*>\s*$/ ; PowerShell /^PS [A-Za-z]:\\[^>]*>\s*$/ ; POSIX /^[^\s@]+@[^\s:]+:[^$#]*[$#]\s*$/
export function needsTerminal(lines: string[], questionPending: boolean): boolean;
//   !questionPending && (hasOptionMenu(lines) || WAITING_PATTERNS match || isShellPrompt(lines))
// useTerminalDrawer.ts
export const DRAWER_POLL_MS = 500;
export const DRAWER_CLOSE_DELAY_MS = 1000;
export function useTerminalDrawer(terminalId: string, enabled: boolean, questionPending: boolean): {
  open: boolean; openedBy: 'auto' | 'user' | null; openByUser(): void; close(): void;
};
```

Add to `WAITING_PATTERNS` (seen live in Claude Code 2.1.318, not matched today): `/Is this a project you created or one you trust\??/i` and `/Enter to confirm\s*·\s*Esc to cancel/i`. Hook: when `enabled`, polls the buffer tail every `DRAWER_POLL_MS`; `needsTerminal` true -> open with `openedBy: 'auto'` and call `useSessionAttentionStore.getState().request(id)` once per opening when the terminal is not the active visible one; auto-opened drawer closes after `needsTerminal` has been false for `DRAWER_CLOSE_DELAY_MS`; user-opened drawer only closes via `close()`. Disabled -> no interval, closed.

- [ ] **Step 1: Failing tests** (use the permission and trust prompt lines captured in QA as fixtures):

```ts
const PERMISSION = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: node sizes.js', '   3. No', ' Esc to cancel · Tab to amend'];
const TRUST = [' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];
```

`needsTerminal(PERMISSION, false)` true; `needsTerminal(PERMISSION, true)` false; `needsTerminal(TRUST, false)` true; `isShellPrompt(['C:\\Users\\tal\\proj>'])` true, `(['PS C:\\x> '])` true, `(['tal@box:~/p$ '])` true, `(['❯ '])` false, `(['> '])` false; `classifySettled(TRUST)` now `waiting`; hook: `opens for the permission prompt regardless of session state` (state seeded `busy`), `closes 1 s after the prompt disappears`, `user-opened drawer stays open`, `requests attention once per opening for a background terminal`, `does nothing when disabled`.
- [ ] **Step 2: Run** `npx vitest run src/lib/terminalState.test.ts src/hooks/useTerminalDrawer.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** focused tests and the existing `terminalState` tests - Expected: pass.
- [ ] **Step 5: Commit** `feat(insight): detect when the hidden terminal needs the user`.

### Task 6: Insight-only layout in TerminalView

**Files:** create `src/components/insight/InsightOnlyView.tsx`, `InsightStatusLine.tsx` + `InsightOnlyView.test.tsx`; modify `src/components/TerminalView.tsx` (~:644 mount and the xterm container), `src/components/insight/InsightLayer.tsx`.

**Interfaces:**
- Consumes: everything above; `InsightLayer`; `QuestionBox` pending state via `useInsightModel`; `terminalStates`; `config.status`; `restartTerminal`.
- Produces: `InsightLayer` gains `variant?: 'panel' | 'fill'` (`fill`: no drag handle, no collapse, fills its container; default `panel` = today). `InsightOnlyView({ terminalId })`. `InsightStatusLine({ terminalId })`.

Layout in `TerminalView` by mode:
- `cli`: today without the layer.
- `mixed`: today's panel above the terminal (unchanged).
- `insight`: the xterm container becomes `absolute inset-0` inside a `relative` pane (same size as before, kept laid out, not `display:none`), and `InsightOnlyView` sits above it (`absolute inset-0`, opaque background, higher z-index) containing `InsightLayer variant="fill"`, `InsightStatusLine` and `PromptBar`. Drawer open: `InsightOnlyView` is visually hidden (`visibility:hidden`, pointer-events none) and a "Terminal" header strip with a close button is shown over the top of the terminal; terminal gets focus; on close, focus returns to the prompt bar. Respect reduced motion for any transition.
- Status line text: busy -> "Working..." with spinner; waiting -> "Waiting for you"; idle -> "Idle"; terminal status Stopped or Error -> "Session ended" plus a "Restart" button calling `restartTerminal(id)`.
- PromptBar `disabledReason`: session ended -> "Session ended"; pending question -> "Answer the question above"; drawer open -> "The terminal is open"; else null.
- Focus: entering Insight mode or selecting an Insight-mode session focuses the prompt bar (only when this terminal is the active one); Esc inside the layer focuses the prompt bar, not xterm.
- The tailer (`useInsightFeed`) runs in both `mixed` and `insight`.

- [ ] **Step 1: Failing tests:** `insight mode keeps the terminal mounted at full size behind the layer` (container has `absolute inset-0`, not `display:none`); `drawer open and close never call fit or resize` (mock the fit addon and `resize_terminal` invoke, toggle the drawer, assert zero calls); `prompt bar disabled with "Answer the question above" while a question is pending`; `session ended shows Restart and disables the bar`; `switching to insight focuses the prompt bar`; `Esc in the layer focuses the prompt bar`; `mixed mode renders the panel variant unchanged`; `cli mode mounts no layer and starts no tailer`.
- [ ] **Step 2: Run** `npx vitest run src/components/insight` - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx tsc --noEmit`, `npm run test:run`, `cd src-tauri && cargo test --locked` - Expected: all pass.
- [ ] **Step 5: Commit** `feat(insight): insight-only view with prompt bar, status line and terminal drawer`.

### Task 7: Live QA

- [ ] Launch the QA instance from a shell with `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` unset, port 5175, `AGENTRIUM_INSTANCE_ID=.qa`, WebView2 remote debugging on 9335 (driven over CDP as in the previous QA). If the first terminal after launch hangs at `cmd /C claude`, close it and open another (known, unrelated).
- [ ] Claude, Insight mode, verify and screenshot: single-line prompt; multiline prompt arrives as one message; `/help` works; Stop interrupts a long turn; a permission prompt opens the drawer by itself, answering it closes the drawer and focus returns to the bar; trust prompt in a new folder opens the drawer; AskUserQuestion shows the box and the bar is disabled meanwhile; switching CLI / Mixed / Insight keeps the terminal width (no reflow); restart keeps the mode; Settings default applies to a new session.
- [ ] Codex (best effort): single-line, multiline, Stop. If any misbehaves, change `availableViewModes` so Codex gets `['cli', 'mixed']`, add a test, commit `fix(insight): disable insight-only view for codex`.
- [ ] Report results, screenshots and any fixes to the user. Do not push or merge.
