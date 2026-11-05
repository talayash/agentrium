# Insight view modes: CLI, Mixed, Insight only

Builds on the insight layer (`2026-11-05-insight-layer-design.md`, branch `feat/insight-layer` in `agentrium/`).

## Why

Some users want to drive an agent session without reading the raw terminal at all. Today the insight layer only sits above the terminal. This adds a per-session view mode so a session can be plain terminal, terminal plus insight, or insight alone with its own prompt bar.

## Goals

- Three view modes per session: **CLI** (terminal only), **Mixed** (insight layer above the terminal, today's behaviour), **Insight** (insight only, terminal hidden, prompt bar).
- Default for new sessions is **CLI**. The user can change the default in Settings. The per-session mode always wins over the default.
- Each session remembers its mode across app restart and session restore.
- In Insight mode the user can do everything a turn needs without seeing the terminal, and the terminal appears by itself when the agent needs something the layer cannot show.

## Non-goals

- Rendering permission prompts as native cards (a later version may add a Claude `Notification` / `PermissionRequest` hook; the terminal drawer covers it for now).
- Attachments, images or file pickers in the prompt bar.
- Changing how the terminal itself works in CLI or Mixed mode.

## Anti-goals (would make this a failure even if it works)

- Shrinking or resizing the PTY to hide the terminal. Claude's TUI reflows to width: a tiny PTY breaks its menus and the question box's on-screen check (seen in QA when the window was minimized). The PTY keeps the pane's real size in every mode.
- The user getting stuck: an agent waiting on a prompt the layer cannot show, with no visible way to answer it.
- A prompt with several lines being submitted early, line by line.

## Decided behaviour

### Modes and controls (user decided)
- Header control: the current "Insight" pill becomes a 3-way switch **CLI | Mixed | Insight** in the session header, same place. `Ctrl+Shift+L` cycles CLI -> Mixed -> Insight -> CLI. The Command Palette gets "View: CLI", "View: Mixed", "View: Insight".
- Settings: "Default view for new sessions" with the three options, default CLI. Replaces today's "New sessions start with insight layer on" toggle.
- Migration: saved sessions with today's `insight_layer: true` open as Mixed, `false`/missing as CLI. The old global toggle `insightLayerDefault: true` becomes default Mixed.

### Insight mode layout
- The terminal stays mounted and keeps the pane's full size, positioned behind the insight layer and not visible (not `display:none`, which would zero its size). No PTY resize when switching between Insight and the drawer.
- The insight layer fills the pane (no drag handle, no collapse: there is nothing under it to give room to).
- **Prompt bar** pinned at the bottom of the pane:
  - Multiline text field. Enter sends, Shift+Enter inserts a newline.
  - Sending writes the text to the PTY as one bracketed paste (`ESC[200~` ... `ESC[201~`) followed by a separate Enter, so a prompt with several lines arrives as one message. (Verify against the live Claude Code TUI in QA; if Claude does not enable bracketed paste, fall back to the approach that the live test shows works.)
  - Up / Down on an empty field (or at the first / last line) walks this session's prompt history, last 50, in memory only.
  - Text starting with `/` is sent as is, so slash commands work.
  - **Stop** button (and Esc while the bar is focused and the agent is busy) sends Esc to the PTY to interrupt.
  - **Show terminal** button opens the drawer by hand.
  - Sending is allowed while the agent is busy (Claude queues it), same as typing in the terminal.
  - The bar is disabled, keeping its text, while a question box is pending (hint: "Answer the question above") or while the drawer is open (hint: "The terminal is open"). A send there would land inside a TUI menu and could pick an option. (Planner's call.)
  - When the session has ended (terminal status Stopped or Error, or the state detector reports the process stopped), the bar is disabled and the status line reads "Session ended" with a **Restart** button that uses the existing restart path (which keeps the session's view mode). (Planner's call.)
  - Focus: switching a session to Insight mode, or selecting an Insight-mode session, focuses the prompt bar. Esc inside the layer returns focus to the bar instead of the terminal.
- **Live progress**: a thin status line above the bar shows the session state (Working... with a spinner while busy, Waiting for you, Idle) using the existing session state detection.

### Terminal drawer (user confirmed)
- The drawer is the real terminal brought in front of the layer at the same size, with a header strip "Terminal" and a close button. Typing goes to the terminal while it is open.
- Opens automatically when the agent needs input the layer cannot show: the terminal screen shows an option menu (`hasOptionMenu`) or matches a waiting pattern (`WAITING_PATTERNS`, including the folder-trust prompt), and there is no question box for it (a pending AskUserQuestion is answered in the box, not the drawer). This check runs on every state poll and does not depend on the session being classified `waiting`, because QA showed Claude's permission menu is classified `busy` while its TUI redraws.
- Closes automatically about 1 second after the screen no longer shows that menu or prompt, and focus returns to the prompt bar. If the user opened it by hand, it stays until they close it.
- Opening raises the existing attention / notification flow the same way a waiting session does.
- Also opens automatically when the agent has dropped back to a plain shell prompt while the PTY is still alive (the screen tail shows a shell prompt and no agent UI), so the user is never typing an agent prompt into a shell. (Planner's call.)

### Mixed and CLI
- Mixed is exactly today's insight layer (drag handle, collapse, small grid cells collapse by default).
- CLI is the plain terminal; the layer is not mounted and costs nothing (today's "off").

### Which sessions get which modes
- Shell terminals and script children: no switch, always CLI.
- Claude: all three modes, must fully work (verified in live QA: send, multiline send, slash command, Stop, drawer for a permission prompt and the trust prompt).
- Codex: CLI and Mixed only, until a Codex-specific send path exists. Live QA showed that a multiline prompt sent through bracketed paste reaches Codex with the newline lost and the trailing Enter does not submit (Codex's paste-burst handling), so the best-effort rule applied and Insight is disabled for Codex rather than shipped half-working. The disabled Insight segment's tooltip reads "Insight view is not available for Codex yet". A stored Insight mode on a Codex session shows as Mixed.
- Agents without a transcript (Cursor, Antigravity, custom): CLI and Mixed only. Insight is shown disabled with the tooltip "No structured data for this agent", since the layer could only show the fallback.

### Works everywhere
- Tab view, grid cells and split panes, like the layer today. In a small grid cell, Insight mode still shows the layer and the bar (the bar may shrink to one line).

## Constraints

- Everything in the insight layer spec and plan Global Constraints still applies (no em-dash or en-dash, no new dependencies, CLAUDE.md error handling, theme tokens, lucide icons).
- The view mode is local only; it is never part of a sync payload.
- The Rust `TerminalConfig` field must deserialize old rows (see Migration).

## Left to the builder

- Exact field names (for example `view_mode: "cli" | "mixed" | "insight"` on `TerminalConfig`, `defaultViewMode` in `appStore`), and whether `insight_layer` is kept as a read-only legacy field or migrated with a custom deserializer.
- Visual styling of the switch, prompt bar, status line and drawer, within the app's existing tokens.
- How the drawer animates, as long as reduced motion is respected.
- Test layout, following the existing insight tests.
