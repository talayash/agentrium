# Issue #22 - Plain-shell toggle + zoom shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plain shell (no Claude)" toggle to the New Terminal modal so users can run wrappers like `ollama launch claude ...`, plus `Ctrl+= / Ctrl+- / Ctrl+0` keyboard shortcuts that live-zoom the terminal font.

**Architecture:** Two independent frontend additions on top of existing infrastructure. The backend already exposes `create_shell_terminal` (used today by the bottom-pane shells); we add a sibling store action that routes its output into the main tab list. The zoom shortcuts route through the existing `setTerminalFontSize` (8–32 clamp) in `appStore`.

**Tech Stack:** React 18 + TypeScript + Zustand. xterm.js. Tauri 2 IPC. No backend (Rust) changes. No new IPC commands.

**Spec:** `docs/superpowers/specs/2026-05-08-issue-22-shell-toggle-zoom-design.md`

---

## File map

| File | Change |
|---|---|
| `src/store/appStore.ts` | Export `DEFAULT_TERMINAL_FONT_SIZE = 14`; reference from initial state |
| `src/store/terminalStore.ts` | Add `createShellTerminalTab(label, cwd, colorTag?, nickname?) => Promise<string>` |
| `src/components/NewTerminalModal.tsx` | Plain-shell toggle, conditional UI, branched submit |
| `src/hooks/useKeyboardShortcuts.ts` | `Ctrl+=` / `Ctrl++` / `Ctrl+-` / `Ctrl+0` handlers with focus-scoping |
| `src/App.tsx` | Restore handler branches on `claude_args[0] === '__shell__'` |

No backend, no IPC, no schema changes.

---

## Task 1: Export `DEFAULT_TERMINAL_FONT_SIZE`

Small precursor - both the store's initial state and the new `Ctrl+0` reset shortcut need a single source of truth for the default size.

**Files:**
- Modify: `src/store/appStore.ts:11` (alongside `DEFAULT_TERMINAL_FONT_FAMILY`)
- Modify: `src/store/appStore.ts:287` (use the new constant)

- [ ] **Step 1: Add the export**

In `src/store/appStore.ts`, just below the existing `DEFAULT_TERMINAL_FONT_FAMILY` constant (around line 11):

```ts
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
```

- [ ] **Step 2: Reference it from initial state**

In `src/store/appStore.ts`, change the line that currently reads:

```ts
      terminalFontSize: 14,
```

to:

```ts
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. (Pre-existing errors unrelated to this task may remain - note them but don't fix them.)

- [ ] **Step 4: Commit**

```bash
git add src/store/appStore.ts
git commit -m "refactor: extract DEFAULT_TERMINAL_FONT_SIZE constant"
```

---

## Task 2: Add `createShellTerminalTab` store action

The existing `openShellTerminal` (line 415) routes the new shell into `bottomTerminalIds` (the bottom pane). For the New Terminal modal we need a sibling that mirrors `createTerminal`'s post-IPC bookkeeping: insert into `terminals`, mark active, fetch git info. Crucially, it must NOT set `isShellTerminal: true` - that flag would hide the terminal from `Sidebar.tsx:76` and `TerminalTabs.tsx:45`.

**Files:**
- Modify: `src/store/terminalStore.ts:53-91` (interface declaration)
- Modify: `src/store/terminalStore.ts:144` (implementation, after `createTerminal`)

- [ ] **Step 1: Declare the action in the `TerminalState` interface**

In `src/store/terminalStore.ts`, add this line right after the `createTerminal` declaration (after line 61, before `closeTerminal`):

```ts
  createShellTerminalTab: (
    label: string,
    workingDirectory: string,
    colorTag?: string,
    nickname?: string,
  ) => Promise<string>;
```

- [ ] **Step 2: Implement the action**

In `src/store/terminalStore.ts`, add this implementation immediately after the closing brace of `createTerminal` (after line 144, before `closeTerminal: async (id) => {`):

```ts
  createShellTerminalTab: async (label, workingDirectory, colorTag, nickname) => {
    try {
      const config = await invoke<TerminalConfig>('create_shell_terminal', {
        label,
        cwd: workingDirectory,
      });
      // Apply nickname/color_tag the user picked in the modal - the backend
      // command takes only label+cwd, so we patch the persisted record here.
      // (Falls back silently if either is empty to avoid a needless IPC.)
      if (nickname) {
        try { await invoke('update_terminal_nickname', { id: config.id, nickname }); } catch { /* non-fatal */ }
      }
      const patchedConfig: TerminalConfig = {
        ...config,
        color_tag: colorTag ?? config.color_tag ?? null,
        nickname: nickname ?? config.nickname,
      };

      set((state) => {
        const newTerminals = new Map(state.terminals);
        // Intentionally NOT setting isShellTerminal - that flag is for bottom-
        // pane shells. Main-tab shells appear in the sidebar and tab bar like
        // any other terminal; their plain-shell-ness is recorded durably in
        // the backend via claude_args=["__shell__"].
        newTerminals.set(patchedConfig.id, {
          config: patchedConfig,
          xterm: null,
          isWorktree: false,
        });
        return {
          terminals: newTerminals,
          activeTerminalId: patchedConfig.id,
        };
      });

      get().fetchGitInfo(patchedConfig.id);

      return patchedConfig.id;
    } catch (error) {
      console.error('Failed to create shell terminal tab:', error);
      throw error;
    }
  },
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/store/terminalStore.ts
git commit -m "feat(store): add createShellTerminalTab for main-tab plain shells"
```

---

## Task 3: Plain-shell toggle in NewTerminalModal

Adds the toggle, hides Claude-only fields when on, branches the submit handler.

**Files:**
- Modify: `src/components/NewTerminalModal.tsx`

- [ ] **Step 1: Pull in the new store action**

Find this destructure (around line 35):

```tsx
  const { terminals, createTerminal } = useTerminalStore();
```

Replace with:

```tsx
  const { terminals, createTerminal, createShellTerminalTab } = useTerminalStore();
```

- [ ] **Step 2: Add the toggle state**

Add this useState alongside the other useStates (around line 47, near `selectedModel`):

```tsx
  const [plainShell, setPlainShell] = useState(false);
```

- [ ] **Step 3: Render the toggle row**

Insert this JSX block immediately after the Nickname field's closing `</div>` (around line 321, just before the `{profiles.length > 0 && (` block):

```tsx
          {/* Plain Shell Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-text-secondary text-[12px]">Plain shell (no Claude)</label>
              <p className="text-text-tertiary text-[11px]">
                Run a regular shell so you can launch wrappers like <code className="text-text-secondary">ollama launch claude</code>
              </p>
            </div>
            <button
              onClick={() => setPlainShell(!plainShell)}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ml-3 ${
                plainShell ? 'bg-accent-primary' : 'bg-border-light'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  plainShell ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
```

- [ ] **Step 4: Hide Claude-only sections when plainShell is on**

Use these exact anchors to find each block:

1. **Profile Selection** - starts with `{profiles.length > 0 && (` (around line 324). Change the opening guard to `{!plainShell && profiles.length > 0 && (` - no other change.

2. **Claude Arguments** - the `<div>` containing `<label>Claude Arguments (one per line)</label>` (around line 524).

3. **Model Selector** - the `<div>` containing `<label>Model</label>` (around line 559).

4. **Effort Selector** - the `<div>` containing `<label>Effort</label>` (around line 583).

For #2, #3, #4, wrap the existing block (the entire `<div>...</div>`) with `{!plainShell && (` and `)}` - do NOT add another `<div>`. The pattern is:

```tsx
{!plainShell && (
  <div>
    {/* existing block, unchanged */}
  </div>
)}
```

Leave Working Directory, Nickname, and the Worktree section visible in both modes. (The modal has no env-vars UI today; env vars only flow in via Profile, so they're naturally absent in plain-shell mode - that's acceptable for v1; users can set them in the shell itself.)

- [ ] **Step 5: Branch the submit handler**

Find `handleCreateTerminal` (around line 221). Replace its body with:

```tsx
  const handleCreateTerminal = async () => {
    setError(null);

    if (!workingDirectory.trim()) {
      setError('Working directory is required.');
      return;
    }

    setIsCreating(true);
    try {
      const selectedProfile = profiles.find(p => p.id === selectedProfileId);
      const baseName = plainShell ? 'Shell' : (selectedProfile?.name || 'Terminal');
      const label = `${baseName} ${terminals.size + 1}`;
      const colorTag = TAG_COLORS[terminals.size % TAG_COLORS.length];

      if (plainShell) {
        await createShellTerminalTab(
          label,
          workingDirectory,
          colorTag,
          nickname || undefined,
        );
      } else {
        const dangerousPattern = /[;&|`$(){}<>^\n\r'"\\~*?[\]!#\t]/;
        for (const arg of claudeArgs) {
          if (dangerousPattern.test(arg)) {
            setError(`Invalid character in argument: "${arg}". Remove shell metacharacters.`);
            setIsCreating(false);
            return;
          }
        }

        const finalArgs = [...claudeArgs];
        if (selectedModel !== 'default') {
          finalArgs.unshift('--model', selectedModel);
        }
        if (selectedEffort !== 'default') {
          finalArgs.unshift('--effort', selectedEffort);
        }
        if (useWorktree) {
          finalArgs.unshift('--worktree');
        }

        await createTerminal(
          label,
          workingDirectory,
          finalArgs,
          envVars,
          colorTag,
          nickname || undefined,
        );
      }

      closeNewTerminalModal();
    } catch (err) {
      console.error('Failed to create terminal:', err);
      setError(String(err));
    } finally {
      setIsCreating(false);
    }
  };
```

- [ ] **Step 6: Update footer button label**

Find the footer Start button (around line 616). Change the inner text from:

```tsx
            {isCreating ? 'Creating...' : 'Start Terminal'}
```

to:

```tsx
            {isCreating ? 'Creating...' : (plainShell ? 'Start Shell' : 'Start Terminal')}
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 8: Manual smoke test**

Start the dev server: `npm run tauri dev`

In the running app:
1. Open New Terminal modal (Ctrl+Shift+N).
2. Toggle "Plain shell (no Claude)" on. Confirm Profile, Claude Arguments, Model, Effort sections vanish; Working Directory, Nickname, Worktree section remain.
3. Toggle off. Confirm the hidden sections come back.
4. Toggle on. Click "Start Shell". Confirm a new tab opens, the shell prompt appears, and typing `cd` (or `pwd`) shows the working directory.
5. In that shell, type `set ANTHROPIC_BASE_URL=http://localhost:11434 && claude --help` (Windows) or the equivalent - confirm it actually runs `claude` (the issue's real use case).

If smoke test fails, fix and re-run before moving on. Don't commit broken UI.

- [ ] **Step 9: Commit**

```bash
git add src/components/NewTerminalModal.tsx
git commit -m "feat(modal): add plain-shell toggle to New Terminal (#22)"
```

---

## Task 4: Zoom keyboard shortcuts

`Ctrl+=` / `Ctrl++` / `Ctrl+-` / `Ctrl+0`. Skip when a non-terminal input has focus.

**Files:**
- Modify: `src/hooks/useKeyboardShortcuts.ts`

- [ ] **Step 1: Add the imports**

At the top of the file, change:

```ts
import { useAppStore } from '../store/appStore';
```

to:

```ts
import { useAppStore, DEFAULT_TERMINAL_FONT_SIZE } from '../store/appStore';
```

- [ ] **Step 2: Add a focus-scope helper**

Add this helper at the top of the file, just above the `export function useKeyboardShortcuts()` line:

```ts
/**
 * Return true when the focused element is an editable surface that is NOT
 * inside an xterm terminal - i.e., a Settings/modal input, a Monaco editor,
 * or the global search box. In those cases we must let key events pass
 * through to the native control instead of hijacking them for terminal zoom.
 */
function isFocusInNonTerminalEditable(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  // xterm's hidden textarea always lives inside an .xterm container - let
  // shortcuts through when the user is "in" a terminal.
  if (el.closest('.xterm')) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}
```

- [ ] **Step 3: Add the zoom handlers inside the existing keydown listener**

Find the existing `handleKeyDown` function (starts around line 26). Just before the closing brace of that function (after the existing `Ctrl+Tab` handler, around line 196), add:

```ts
      // Terminal font zoom. Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0.
      // Skip when the user is in a non-terminal editable surface so that
      // e.g. Ctrl+- in a Settings input still selects characters natively.
      if (ctrl && !shift && (e.key === '=' || e.key === '-' || e.key === '0')) {
        if (isFocusInNonTerminalEditable()) return;
        e.preventDefault();
        const { terminalFontSize, setTerminalFontSize } = useAppStore.getState();
        if (e.key === '=') setTerminalFontSize(terminalFontSize + 1);
        else if (e.key === '-') setTerminalFontSize(terminalFontSize - 1);
        else setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
        return;
      }
      // Ctrl++ (with Shift) - same as Ctrl+= for users who reflexively press shift.
      if (ctrl && shift && e.key === '+') {
        if (isFocusInNonTerminalEditable()) return;
        e.preventDefault();
        const { terminalFontSize, setTerminalFontSize } = useAppStore.getState();
        setTerminalFontSize(terminalFontSize + 1);
        return;
      }
```

Note: `setTerminalFontSize` already clamps to `[8, 32]` (appStore.ts:386), so out-of-range values become silent no-ops at the boundary.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Manual smoke test**

In the running dev app:
1. Click into a terminal, press `Ctrl+=` ten times. Font grows one px each press up to 32, then stops.
2. Press `Ctrl+-` repeatedly down to 8 - confirm it stops at 8.
3. Press `Ctrl+0`. Font snaps back to 14.
4. Open Settings (Ctrl+,), click into the "Default Claude Args" textarea, press `Ctrl+-`. Confirm the character is selected backwards (native behavior) and the terminal font does NOT change.
5. Restart the app. Set zoom to 18, restart, confirm terminals open at 18 (`partialize` already includes `terminalFontSize`).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useKeyboardShortcuts.ts
git commit -m "feat(shortcuts): add Ctrl+= / Ctrl+- / Ctrl+0 terminal zoom (#22)"
```

---

## Task 5: Restore handler branch for `__shell__`

Crash recovery currently calls `createTerminal` for every saved terminal - including those with `claude_args=["__shell__"]` (a sentinel set by the backend's `create_shell_terminal`). That would try to spawn `cmd /C claude __shell__`, which fails. Branch on the sentinel and route through `createShellTerminalTab` instead.

**Files:**
- Modify: `src/App.tsx:280-289` (inside `handleRestore`)

- [ ] **Step 1: Pull in the new store action in App.tsx**

Find the `useTerminalStore` destructure (around line 96):

```tsx
  const { handleTerminalOutput, updateTerminalStatus, setLoopMode, setSessionSummary, createTerminal } = useTerminalStore();
```

Replace with:

```tsx
  const { handleTerminalOutput, updateTerminalStatus, setLoopMode, setSessionSummary, createTerminal, createShellTerminalTab } = useTerminalStore();
```

- [ ] **Step 2: Branch on the `__shell__` sentinel inside `handleRestore`**

Find the `for` loop body (around line 278):

```tsx
    for (let i = 0; i < pendingRestoreConfigs.length; i++) {
      const config = pendingRestoreConfigs[i];
      try {
        await createTerminal(
          config.label,
          config.working_directory,
          config.claude_args,
          config.env_vars,
          config.color_tag ?? undefined,
          config.nickname ?? undefined,
          logs[i] ?? undefined
        );
      } catch (err) {
        console.error('Failed to restore terminal:', config.label, err);
      }
    }
```

Replace the body with:

```tsx
    for (let i = 0; i < pendingRestoreConfigs.length; i++) {
      const config = pendingRestoreConfigs[i];
      try {
        if (config.claude_args[0] === '__shell__') {
          // Plain shell - re-spawn as a main-tab shell. We deliberately don't
          // restore the script-runner sentinel '__script__' here; that's a
          // child terminal owned by its parent and gets recreated on demand.
          await createShellTerminalTab(
            config.label,
            config.working_directory,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
          );
        } else if (config.claude_args[0] === '__script__') {
          // Script runner - owned by parent terminal, skip on restore.
          continue;
        } else {
          await createTerminal(
            config.label,
            config.working_directory,
            config.claude_args,
            config.env_vars,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
            logs[i] ?? undefined
          );
        }
      } catch (err) {
        console.error('Failed to restore terminal:', config.label, err);
      }
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Manual smoke test (best-effort - depends on runtime conditions)**

Crash recovery is normally only offered when the previous session ended unexpectedly. To exercise it deterministically:
1. In the dev app, create a plain-shell tab (Task 3 path).
2. Force-quit the app (close the window without graceful shutdown - e.g., Task Manager → End Task on the dev process).
3. Relaunch. If the restore banner appears, click "Restore" and confirm the plain-shell tab comes back as a working shell (NOT as a failed `claude __shell__` terminal).

If the restore banner doesn't appear in this scenario, the code path is exercised purely by the type-checker and code review - that's acceptable for this task. Note in the commit body that smoke-testing crash recovery is environment-dependent.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "fix(restore): route __shell__ sentinel through createShellTerminalTab (#22)"
```

---

## Task 6: Final verification

Run the project's verification pipeline before declaring done.

- [ ] **Step 1: TypeScript type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors introduced by this branch.

- [ ] **Step 2: Lint**

Run: `npm run lint` (if a lint script exists in `package.json`; otherwise skip and note in commit).
Expected: clean, or only pre-existing warnings.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds. Watch for unused-import warnings on the files touched.

- [ ] **Step 4: Re-run all manual smoke tests in one session**

In `npm run tauri dev`, exercise in order:
1. Claude path still works: New Terminal → no toggle → Start Terminal → claude prompt appears.
2. Plain shell path: New Terminal → toggle on → Start Shell → shell prompt; run `ollama launch claude --help` (or any non-claude command) to prove the wrapper use case.
3. Toggle round-trip: in the modal, toggle on then off - Profile/Args/Model/Effort sections re-appear with their previous values intact.
4. Plain shell respects worktree selection: with a git repo as working directory, pick a worktree, toggle plain shell on, Start Shell - shell opens at the worktree path.
5. Zoom in/out/reset (Ctrl+= / Ctrl+- / Ctrl+0) works inside terminal focus, NOT inside Settings inputs.
6. Restart and confirm font size persists.

- [ ] **Step 5: Update the issue**

Comment on issue #22 acknowledging the fix shipped (delivery is automatic via the next release cycle - no extra action needed). Don't close the issue here; the release workflow does that downstream.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Plain-shell toggle in NewTerminalModal | Task 3 |
| Hide list (Profile/Args/Model/Effort) when toggle on | Task 3 step 4 |
| Footer button "Start Shell" vs "Start Terminal" | Task 3 step 6 |
| `createShellTerminalTab` store action | Task 2 |
| `DEFAULT_TERMINAL_FONT_SIZE` extracted | Task 1 |
| `Ctrl+=` zoom in | Task 4 step 3 |
| `Ctrl++` (with Shift) zoom in | Task 4 step 3 |
| `Ctrl+-` zoom out | Task 4 step 3 |
| `Ctrl+0` reset | Task 4 step 3 |
| Focus-scoping (skip non-terminal inputs) | Task 4 step 2 |
| Persistence (font size survives restart) | Free - already in `partialize` |
| Restore-handler `__shell__` branch (flagged risk) | Task 5 |
| Manual test plan items 1–8 | Tasks 3, 4, 6 step 4 |
