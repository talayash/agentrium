# Issue #22 — Plain-shell toggle + zoom shortcuts

**Date:** 2026-05-08
**Issue:** [#22](https://github.com/talayash/claude-terminal/issues/22) — "cant zoom in, cant scroll up, cant use ollama"
**Status:** Design

## Background

Issue #22 reported three complaints. Item 2 (scrollback) is already resolved on the in-flight branch via the appearance settings (default scrollback raised to 50,000). This spec covers the remaining two:

1. **Item 1 — `ollama launch claude ...`:** the New Terminal flow hardcodes `cmd /C claude [args]`, so users can't run wrappers around Claude.
2. **Item 3 — Zoom:** font size is configurable in Settings → Appearance (8–32 px) but there is no keyboard shortcut, so users have to open Settings to change it.

## Goals

- Let users start a terminal that runs **any** command, not just `claude`, from the New Terminal modal — explicitly to enable `ollama launch claude ...` and similar wrappers.
- Let users zoom the terminal font in/out and reset it without opening Settings.

## Non-goals

- Persisting the wrapper command per profile (out of scope for this iteration; if requested later, becomes a "command prefix" or "executable" field on `ConfigProfile`).
- Per-terminal font size. Zoom changes the global setting — the same one Settings → Appearance sets.
- Touching the existing bottom-pane plain-shell flow (already shipped, lives in `bottomTerminalIds`).

## Approach

### Part 1 — "Plain shell" toggle in NewTerminalModal

A single toggle near the top of `NewTerminalModal.tsx`, labeled **"Plain shell (no Claude)"**. When on:

- Hide: Profile selector, Claude Arguments textarea, Model selector, Effort selector.
- Keep: Nickname, Working Directory, Worktree section, Env Vars (env vars stay because they're how users could route Claude through Ollama via `ANTHROPIC_BASE_URL` etc.).
- Footer button label flips from **"Start Terminal"** → **"Start Shell"**.
- Submit calls a new store action `createShellTerminalTab(label, workingDirectory, colorTag, nickname)` instead of `createTerminal(...)`.

The toggle defaults to **off** (preserves existing behavior). Toggle state is *not* persisted — every new modal opens in Claude mode.

#### Backend

No changes. `create_shell_terminal` IPC command already exists (`commands.rs:3000`) and is already exposed to the frontend.

#### Store

`src/store/terminalStore.ts` already has `openShellTerminal(label, cwd)` (line 415), but it routes the new terminal into the **bottom pane** (`bottomTerminalIds`) — not the main tab list. The modal needs a sibling helper that mirrors `createTerminal`'s post-IPC bookkeeping (insert into `terminals`, mark `activeTerminalId`, no `bottomTerminalIds` push).

Add `createShellTerminalTab(label, cwd, colorTag?, nickname?)`:
- Invokes `create_shell_terminal` IPC.
- Inserts into `terminals` map with `isShellTerminal: true`, `isWorktree: false`.
- Sets it as the active terminal (matches `createTerminal` UX so the user sees their new shell).
- Returns the new terminal id.

The two helpers (`openShellTerminal` for bottom pane, `createShellTerminalTab` for main tabs) intentionally stay separate because their post-create routing is genuinely different — sharing a "where to put it" parameter would be a worse boundary than two small functions.

#### Modal

`src/components/NewTerminalModal.tsx`:
- Add `const [plainShell, setPlainShell] = useState(false)` near other useState hooks.
- Add toggle row at the top of the content area (just below the Nickname field), styled like the existing "Isolated Worktree" toggle for visual consistency.
- Wrap Profile, Claude Arguments, Model, Effort blocks in `{!plainShell && (...)}`.
- In `handleCreateTerminal`, branch on `plainShell`:
  - Plain shell path: validate working directory only (skip Claude-arg validation), call `createShellTerminalTab(label, workingDirectory, colorTag, nickname || undefined)`.
  - Claude path: existing behavior unchanged.
- Footer button text: `plainShell ? 'Start Shell' : 'Start Terminal'`.

### Part 2 — Zoom keyboard shortcuts

`src/hooks/useKeyboardShortcuts.ts` gets three new bindings:

- **`Ctrl+=`** (and `Ctrl++` for users who reflexively press shift): font size +1.
- **`Ctrl+-`**: font size −1.
- **`Ctrl+0`**: reset to default.

#### Constants

In `src/store/appStore.ts`, extract the existing inline default:

```ts
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
```

…and reference it from both the store's initial state and the new reset shortcut. The store's existing `setTerminalFontSize` already clamps to `[8, 32]`, so all three shortcuts route through it without extra clamping.

#### Focus scoping

Zoom must NOT fire when the user is typing in:
- A modal input/textarea (Settings, NewTerminal, Profile, etc.).
- The Monaco editor (file tabs).
- The global search input.

It SHOULD fire when:
- A terminal has focus (xterm's `xterm-helper-textarea`).
- Nothing in particular is focused (e.g. user just clicked into the chrome).

Detection: in the `keydown` handler, check `document.activeElement`. If it's an `INPUT`, `TEXTAREA`, or `[contenteditable="true"]` element AND it's NOT inside an `.xterm` container, skip the zoom action and let the keypress fall through (so `Ctrl+-` in a Settings input still does its native behavior, e.g. selecting characters).

This mirrors how the existing `Ctrl+F` xterm-search handler differentiates itself from `Ctrl+Shift+F` global search.

#### Persistence

`terminalFontSize` is already in `partialize` (appStore.ts:691). Zoom changes survive restart for free.

## Components touched

| File | Change |
|---|---|
| `src/store/terminalStore.ts` | Add `createShellTerminalTab` action |
| `src/store/appStore.ts` | Export `DEFAULT_TERMINAL_FONT_SIZE = 14` |
| `src/components/NewTerminalModal.tsx` | Plain-shell toggle, conditional UI, branched submit |
| `src/hooks/useKeyboardShortcuts.ts` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` handlers |

No backend (Rust) changes. No new IPC commands. No schema changes.

## Error handling

- **Plain shell toggle:** Same error surface as Claude path — `setError(String(err))` on IPC failure. Working-directory empty check still applies (currently `if (!workingDirectory.trim())`).
- **Zoom shortcuts:** `setTerminalFontSize` clamps silently at boundaries (8 and 32). At the limits, the shortcut becomes a no-op — that's acceptable; matches Chrome/VS Code zoom behavior.

## Testing plan

Manual (the project doesn't have unit tests for the modal/shortcut layer):

1. **Plain shell happy path:** Open New Terminal → toggle "Plain shell" → enter working dir → Start Shell. Terminal opens, prompt visible (`cmd.exe` on Windows). Type `ollama launch claude --help` and confirm it runs.
2. **Plain shell hides Claude UI:** With toggle on, Profile/Args/Model/Effort sections are gone; toggle off restores them; previously-selected profile/args are not lost during the toggle round-trip.
3. **Plain shell + worktree:** Toggle on, pick a worktree from the list, Start Shell. Resulting shell's CWD is the worktree path.
4. **Plain shell + env vars:** Set `ANTHROPIC_BASE_URL=http://localhost:11434` in env vars, Start Shell, run `claude` from inside it. Confirms the env wrapper path the issue author actually wants.
5. **Zoom in terminal:** Focus terminal, hit `Ctrl+=` ten times — font grows one px each press until it caps at 32.
6. **Zoom out + reset:** `Ctrl+-` shrinks; `Ctrl+0` returns to 14 regardless of current size.
7. **Zoom doesn't fire in modal:** Open Settings, click into the Claude-args textarea, press `Ctrl+-` — character is selected backwards (native), font does NOT change.
8. **Zoom persists:** Set to 18, restart app, terminal opens at 18.

## Risks

- **Plain shell as restorable session:** existing `claude_args: vec!["__shell__".into()]` sentinel in `terminal.rs:433` already exists for this — restore code paths must handle it, but they do today (the bottom-pane shell uses the same sentinel). Since this design routes shells into the main tab list rather than the bottom pane, restore will pick them up like any other terminal — verify the existing crash-recovery path treats `__shell__` correctly when the terminal lives in `terminals` rather than `bottomTerminalIds`. If it doesn't, restore will need a small branch; flag during implementation.
- **Ctrl+= layout dependence:** `e.key === '='` matches US keyboards; non-US layouts where `=` requires Shift may be inconsistent. Acceptable — VS Code has the same caveat. Users on those layouts can fall back to Settings → Appearance.
