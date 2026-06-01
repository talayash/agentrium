# Session State + Smart Notifications — Design

**Date:** 2026-06-01
**Status:** Approved (design); ready for implementation planning
**Area:** Frontend (React/TypeScript/xterm.js) + minimal app-window focus wiring

## Problem

ClaudeTerminal can tell you a terminal is *producing output* (the green "working" dot
in `TerminalTabs.tsx`, driven by a purely time-based `lastOutputAt < 2000ms` check), and
it tells you when a Claude **process exits** (`terminal-finished` → toast + optional
notification). It cannot tell you the one thing that matters most when running several
sessions in parallel: **which session is blocked waiting for your answer** versus merely
churning versus finished-its-turn-and-idle.

Research (verified against Anthropic primary docs and peer tools) found this is the single
most-validated gap: Claude Code shipped "Agent View" (running / blocked-on-you / done) and
CCManager markets per-session busy/waiting/idle indicators specifically against tools that
lack them. Separately, users repeatedly ask (CC issues #12048, #13830, #13024) to be
notified **only when Claude genuinely needs attention**, not on every completion, which
causes alert fatigue.

Claude Code exposes **no machine-readable state signal**, so state must be *inferred* from
terminal output — the same approach CCManager uses.

## Goals

- Detect and surface per-terminal Claude state: **Busy · Waiting-for-decision · Idle · Stopped**.
- Fire a native notification **only** when a session enters Waiting-for-decision and the
  user isn't already looking at it.
- Build on existing infrastructure (`lastOutputAt` activity tracking, `unreadTerminalIds`,
  `send_notification` / `useNotification`, the title-bar Recent Terminals dropdown, the
  Settings DND-hours + sound options).

## Non-goals (YAGNI)

- No "turn complete / idle" notification (attention-only by decision).
- No backend/Rust detection — detection is frontend-side using xterm's parsed buffer.
- No new standalone sidebar panel — the Agent View reuses the existing Recent Terminals dropdown.
- No machine-readable IPC with Claude Code (none exists); heuristic classification is accepted.
- No multi-CLI / non-Claude support.

## State model

Four states, tracked **only for Claude terminals** (excluded: plain-shell terminals,
script children, bottom-pane shells — identified via `isShellTerminal` / `scriptParentId`
/ plain-shell flag on the instance).

| State | Meaning | Detection |
|---|---|---|
| **Busy** | Streaming tokens / running tools | `now - lastOutputAt < BUSY_WINDOW_MS` (~600ms) |
| **Waiting-for-decision** | Blocking prompt awaiting the user | Output settled **and** classifier matches a prompt pattern |
| **Idle** | Turn finished, at the empty input box | Output settled **and** no prompt pattern matched |
| **Stopped** | Process exited | Existing `terminal-finished` event |

"Needs attention" == Waiting-for-decision, and nothing else.

## Detection

### Pure classifier module — `src/lib/terminalState.ts`

```
export type SessionState = 'busy' | 'waiting' | 'idle' | 'stopped';

// Given the bottom N rows of xterm's already-parsed buffer (clean text, no ANSI),
// decide between a blocking prompt and a plain idle prompt.
export function classifySettled(lines: string[]): 'waiting' | 'idle';
```

- Input is clean text read from `instance.xterm.buffer.active` (xterm has already parsed
  ANSI), so we never hand-roll escape-code stripping.
- Patterns live in one exported, versioned list (`WAITING_PATTERNS`) so they're cheap to
  update as Claude Code's UI evolves. Initial set (case-insensitive, trimmed):
  - Numbered choice menus: a line matching `^❯?\s*\d+\.\s+` near another `\d+\.\s+` line.
  - Yes/No selectors containing `❯` plus `Yes`/`No`.
  - Permission / proceed prompts: `Do you want to proceed`, `Do you want to`, `(y/n)`,
    `[y/N]`, `Allow this tool`, tool-use permission phrasing.
  - Trust prompt: `Do you trust the files in this folder`.
- **Fail-safe:** if classification is uncertain, return `'idle'`. We must never falsely
  raise "needs attention." (A missed prompt is a minor annoyance; a false alarm erodes
  trust in the whole feature.)

### Driver — single global poller

One ~500ms interval (mounted once, e.g. in `App.tsx` or a dedicated hook
`useSessionStateDetection`) that, for each Claude terminal:

1. If `now - lastOutputAt < BUSY_WINDOW_MS` → `busy`.
2. Else read the bottom ~15 rows of `instance.xterm.buffer.active`, join to `lines`,
   call `classifySettled(lines)` → `waiting` | `idle`.
3. Call `setTerminalState(id, state)` (no-ops when unchanged).

xterm instances persist for **all** tabs (output is written to `instance.xterm` regardless
of which tab is active — see `handleTerminalOutput`), so background sessions classify
correctly. (Planning must confirm `TerminalView` keeps the xterm mounted for inactive tabs;
if any path disposes it, fall back to the last-known state for that terminal.)

## State store

- High-frequency `lastOutputAt` stays in the existing plain Map in `terminalActivity`
  (no Zustand `set()` on the streaming hot path — preserves the current optimization).
- New Zustand state in `terminalStore`: `terminalStates: Map<string, SessionState>` plus
  `setTerminalState(id, state)` which **returns the same state object when unchanged** so
  no needless re-renders fire. Transitions are infrequent, so writing them to Zustand is fine.
- `closeTerminal` / cleanup removes the id from `terminalStates` (alongside the existing
  `clearTerminalActivity`).
- `terminal-finished` sets state to `stopped`.

## UI surfacing

### Tab indicator (`TerminalTabs.tsx`)

Replace the binary `isWorking` dot with a state-driven dot:

- `busy` → pulsing green (current behavior).
- `waiting` → pulsing **amber** "attention" dot (`title="Claude needs your input…"`).
- `idle` → faint/no dot.
- `stopped` → gray dot.

Honors the existing Reduce-motion setting (no pulse animation when enabled — same gate the
current `ct-working-dot` uses). The amber accent is added to the existing CSS class set.

### Agent View (upgrade Recent Terminals dropdown — `titlebar/RecentTerminalsMenu.tsx`)

- Each row shows a small state pill (Busy / Waiting / Idle / Stopped) with matching color.
- Rows **sort Waiting-for-decision to the top**, then Busy, then Idle, then Stopped.
- The toolbar Layers icon gets a colored **count badge** when ≥1 session is Waiting.
- Grid view (`TerminalGrid.tsx`) reuses the same dot component for per-cell state.

## Notifications

- On a **transition into** `waiting`, fire exactly one native notification
  (`useNotification().notify`) **unless** that terminal is the active tab **and** the app
  window is focused (i.e., the user is already looking at it).
- Dedup via a per-terminal `notifiedForPrompt` flag set when the notification fires and
  cleared when the terminal leaves `waiting`. This prevents re-firing while the prompt
  remains on screen across poll ticks.
- Respects existing DND-hours and notification-sound Settings (reuse the same gating the
  app already applies to notifications).
- **No** idle/turn-complete notification. The existing `notifyOnFinish` (process-exit) path
  is unchanged.

### Window focus

Track whether the app window is focused (Tauri window focus events, surfaced as a small
`useWindowFocused()` hook or a store boolean). Used solely by the notification suppression
rule above.

## Edge cases

- **Multi-step tool runs:** the `BUSY_WINDOW_MS` settle window prevents flickering to
  Idle/Waiting between rapid tool outputs.
- **Classifier uncertainty:** defaults to `idle` — never a false "needs attention."
- **Plain shells / script children / bottom-pane shells:** skipped entirely; they have no
  Claude prompt semantics.
- **Restored sessions:** restored output is painted into xterm on mount; the poller will
  classify the current on-screen state on its next tick like any other terminal.
- **Disposed xterm (if any inactive-tab path disposes it):** retain last-known state rather
  than forcing a default.

## Testing

- `classifySettled()` is pure → unit tests against fixtures captured from real Claude
  output: permission/proceed dialog, AskUserQuestion numbered menu, Yes/No selector, trust
  prompt, plain idle input box, and a mid-stream snapshot (should never be called for Busy,
  but verify it doesn't classify partial output as Waiting). Include a Reduce-motion-agnostic
  data-only test of the state→dot mapping.
- Transition→notification logic tested with a mocked clock and mocked focus/active-tab
  state: fires once on entry, suppressed when active+focused, re-arms after leaving Waiting,
  respects DND.
- State store `setTerminalState` no-op-on-unchanged test (referential stability).

## Tuning constants (initial values, revisit during implementation)

- `BUSY_WINDOW_MS = 600`
- `POLL_INTERVAL_MS = 500`
- `BUFFER_TAIL_ROWS = 15`

## Open items for planning

- Confirm inactive-tab `TerminalView` keeps its xterm mounted (assumed yes from
  `handleTerminalOutput`); decide fallback if not.
- Confirm the exact existing DND/sound gating helper to reuse so notification behavior is
  consistent with the rest of the app.
