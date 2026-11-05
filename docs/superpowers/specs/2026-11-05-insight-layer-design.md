# Feature: "Insight layer" view mode above the terminal output

Work in the `agentrium/` desktop repo (Tauri 2 + React 18). Read `agentrium/CLAUDE.md` first and follow its rules. Start with the brainstorming skill, then write a plan before touching code.

## Goal

Add a new **view mode** to each agent session: a visual layer that sits **above the xterm CLI output** and shows what the agent just did and returned, in a short, organized, visual form. The raw terminal stays fully available underneath; the layer is a readable digest of it, not a replacement.

Two jobs:

1. **Result digest.** After each agent turn, show a compact card: what was asked, what the agent did, what it returned. Summed up, grouped, and visualized where the data allows it.
2. **Question box.** When the agent asks the user a question with multiple choice answers (Claude Code's `AskUserQuestion` tool, or a numbered option menu in the TUI), render it as a proper box with clickable options instead of making the user read the TUI menu.

## Toggle (session level)

- On/off **per session (per terminal)**, not global. Each terminal remembers its own state.
- Persist the flag with the rest of the terminal config so it survives app restart and session restore (Rust side uses `#[serde(default)]` so old rows load as off).
- Controls: a toggle button in the terminal header/status bar (`TerminalStatusBar.tsx`), a Command Palette entry, and a keyboard shortcut (register it in `useKeyboardShortcuts.ts`, pick one that does not collide).
- Optional: a global default in Settings ("New sessions start with insight layer on"), but the per-session flag always wins.
- When off, zero cost: no transcript watching, no parsing, no extra renders.

## Data source (do not scrape the terminal for structured data)

The app already binds each terminal to its agent transcript:

- Claude: `TerminalConfig.claude_session_id` -> `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (see `src-tauri/src/claude_session.rs`, `session_file_path`).
- Codex: `~/.codex/sessions/.../rollout-*.jsonl` (see `src-tauri/src/codex_session.rs`).

Build on that:

1. Rust: a command/event that tails the session JSONL from a byte offset and emits new records to the frontend for that terminal only (start when the layer is on, stop when off or terminal closes). Parse defensively: unknown record types are skipped, never crash. Unit-test the parser with fixture JSONL lines.
2. Frontend: a pure `src/lib/insightModel.ts` that turns records into a typed view model per turn: user prompt, assistant text, tool calls (name, target, status), files touched, commands run with exit status, errors, token/cost if present (the OTel `terminalMetrics` already exist in `terminalStore`), and pending questions. Pure functions, fully unit-tested.
3. Fallback when no transcript is available (other agents, plain shells): show only what can be derived safely (state from `useSessionStateDetection`, the option-menu detection already in `src/lib/terminalState.ts`), and say "No structured data for this agent" instead of guessing.

## What the layer shows

Per turn, newest first, collapsible, older turns compacted:

- **Headline:** one line summary of the turn (from the final assistant text; truncate, do not call an LLM for v1).
- **Stats strip:** small stat tiles: files changed, commands run, tests passed/failed, errors, duration, tokens/cost.
- **Activity breakdown:** a small bar or timeline of tool calls by type (Read / Edit / Bash / Search / Web ...).
- **Files touched:** list with +/- line counts, clicking opens the file in the existing editor/diff view (`FileEditorView`, `InlineDiffView`).
- **Structured results:** when the assistant output contains a markdown table, JSON, or a list of numbers, render it as a real table or a simple chart (bar/line). Keep detection conservative; when unsure, render as formatted markdown.
- **Errors:** highlighted, with a "jump to terminal output" link that scrolls xterm to the matching spot.

Reuse the existing session-wide pieces where they fit (`SessionInsights.tsx`, `SessionMetricsPanel.tsx`, `SessionTimeline.tsx`) instead of building parallel versions.

## Question box

- When the transcript shows a pending `AskUserQuestion` tool_use (no matching tool_result yet), render a box at the top of the layer: the question, a header chip, each option as a button with its description, multi-select when the tool input says so, plus an "Other" free text field.
- If the question carries data (options with previews, numbers, comparisons), visualize it: side by side option cards, preview content rendered, a small comparison chart when options have numeric attributes.
- Clicking an option answers by **writing the matching keystrokes to the PTY** (the same input path the terminal uses), so the agent receives a normal answer. Verify the exact key sequence against the live Claude Code TUI (arrow keys + Enter vs. number keys) and cover it with a test.
- The box disappears as soon as the tool_result lands or the terminal leaves the `waiting` state.
- It should also raise the existing attention/notification flow the same way a waiting session does today.

## Layout reference (sketch)

Target layout for one session pane with the layer on. Sample data only.

```
+-----------------------------------------------------------------------------+
| [>_] fix-sync-agent  (waiting)             Opus 5.5 · $0.42  [Insight: on]  |  header + per-session toggle
+-----------------------------------------------------------------------------+
| (?) [Sync strategy]  How should the agent binary path be resolved on UNC?   |  QUESTION BOX
| +----------------------+ +----------------------+ +----------------------+  |  (only while a question
| | Map to drive letter  | | Copy binary locally  | | Keep UNC, add retry  |  |   is pending; accent tint)
| | Recommended          | | +40 MB per user      | | Smallest change      |  |
| | [########--] 85%     | | [#########-] 95%     | | [#####-----] 55%     |  |  option cards, selected one
| +----------------------+ +----------------------+ +----------------------+  |  has a 2px accent border
| [ Other answer ...................................... ]  [Answer (enter)]   |
+-----------------------------------------------------------------------------+
| * Turn 4: resolved agent path, 2 tests still failing              1m 52s    |  TURN DIGEST (newest first)
| +--------+ +--------+ +--------+ +--------+ +--------+                      |
| |   4    | |   7    | |   38   | |   2    | |  18k   |                      |  stat tiles
| | files  | | cmds   | | passed | | failed | | tokens |                      |
| +--------+ +--------+ +--------+ +--------+ +--------+                      |
| Activity                         | Files touched                            |
|  Read   [#########]  9           |  src-tauri/src/sync.rs      +42  -9      |  bar chart by tool type,
|  Edit   [#####----]  5           |  src-tauri/src/paths.rs     +18  -3      |  clickable file list
|  Bash   [#######--]  7           |  src/lib/agents.ts           +6  -6      |
|  Search [####-----]  4           |  src/lib/agents.test.ts     +31  -0      |
| [!] sync::tests::unc_path_roundtrip: expected "\\srv\share", got "Z:\"      |  error strip
|                                                    [Jump to output]         |  -> scrolls xterm
| > Turn 3: read sync module, proposed plan  · > Turn 2 · > Turn 1            |  older turns collapsed
+================================ drag handle ================================+  resizable
| > cargo test sync                                                           |  RAW XTERM OUTPUT
| test sync::tests::unc_path_roundtrip ... FAILED                             |  (unchanged)
| test result: FAILED. 38 passed; 2 failed                                    |
| ? How should the agent binary path be resolved on UNC shares?               |
| > 1. Map to drive letter (Recommended)                                      |  the TUI menu the
|   2. Copy binary locally                                                    |  question box answers
+-----------------------------------------------------------------------------+
```

Behavior shown in the sketch:

- Header toggle flips the whole layer off; the pane becomes the plain terminal.
- Clicking an option card selects it; "Answer" sends the TUI keystrokes (for example Down x N + Enter) to the PTY.
- Collapsed state: a single thin bar with the latest headline and a pending-question badge.

## Layout and UX

- The layer is an overlay/panel **above the terminal output inside the same pane**, resizable with a drag handle, collapsible to a thin bar showing just the latest headline + a pending-question badge.
- Works in tab view, grid (`TerminalGrid.tsx`), and split (`SplitView.tsx`). In small grid cells it collapses to the thin bar by default.
- Must not steal keyboard focus from xterm unless the user clicks into it. Esc returns focus to the terminal.
- Follow the app's existing theme tokens (light/dark, accent theme), Tailwind classes, and `lucide-react` icons. Check `package.json` before adding a chart library; prefer lightweight inline SVG for v1 if nothing exists.
- Performance: parse off the streaming hot path, throttle updates (for example every 300 ms), cap stored turns per session, virtualize the list if long.

## Out of scope for v1

- LLM-generated summaries (leave a hook for it).
- Sync of the layer data to agentrium-api (no contract change; if you think one is needed, stop and ask).

## Done when

- Toggle works per session, persists across restart, and costs nothing when off.
- A Claude session shows per-turn digests with stats, activity breakdown, files, and at least table + bar chart rendering for structured output.
- An `AskUserQuestion` prompt shows as a clickable box and clicking an option actually answers the agent in the live TUI.
- Tests: Rust JSONL tail/parser tests, `insightModel` unit tests, component tests for the layer, toggle, and question box.
- `npx tsc --noEmit`, `npm run test:run`, and `cd src-tauri && cargo test --locked && cargo clippy` all pass.
- Manually checked in an isolated QA instance (`/qa` skill), with screenshots of: layer on, layer collapsed, a question box, and layer off.
- Work on a feature branch, nothing pushed or released without asking.
