# Paste-as-File Design

**Status:** Approved (design phase)
**Date:** 2026-05-10
**Target version:** 1.21.0

## Problem

Pasting large text (logs, JSON, stack traces) directly into a Claude Code terminal session is unreliable: rendering is slow, the PTY can drop bytes, and Claude Code itself often handles huge prompt blocks poorly. The user's existing workaround is manual: save the text to a file outside the app, then prompt Claude Code with `"check logs at <path>"`. We want a built-in flow that does the same thing in a few clicks.

## Goals

- One-click capture of a large paste into a file inside the active terminal's working directory.
- Auto-reference that file in Claude Code via the native `@mention` syntax so the file is attached to the next prompt.
- Stay scoped to the terminal's working dir so Claude Code's permission model accepts the path without prompting.
- Throwaway by default — files clean up when the terminal closes; longer retention is opt-in.

## Non-goals (v1)

- Cross-terminal sharing of pastes.
- Cloud sync.
- Inline diff/preview against prior pastes.
- Auto-language detection beyond `json` / `log` / `xml` / `txt`.

## Architecture

### New files

- `src/components/PasteAsFileDrawer.tsx` — slide-in right-side drawer (Framer Motion, dark glassmorphic, matches existing modals).
- `src/store/pasteStore.ts` — in-memory `Map<terminalId, PasteHistoryEntry[]>`. Not persisted (disk is the source of truth).
- `src-tauri/src/pastes.rs` — pure filesystem helpers: write, list, read, delete, purge.

### Modified files

- `src/store/appStore.ts` — adds `isPasteDrawerOpen: boolean` and `pasteDrawerSeed: { content?: string; targetTerminalId?: string } | null`.
- `src/store/terminalStore.ts` — `closeTerminal` calls `invoke('purge_pastes', { terminalId })` (best-effort, errors logged) before removing the terminal from the map.
- `src/components/TerminalView.tsx` — auto-detect interception on `onData` chunks above threshold (see below).
- `src/components/TerminalStatusBar.tsx` — adds the "Paste as file" toolbar button.
- `src/components/SettingsModal.tsx` — adds a "Pastes" section (threshold, prompt template, retention).
- `src/hooks/useKeyboardShortcuts.ts` — registers `Ctrl+Shift+V` to open the drawer pre-filled from clipboard.
- `src-tauri/src/commands.rs` — five new `#[command]` handlers (see IPC).
- `src-tauri/src/main.rs` — registers the new commands and (for retention != "delete on close") spawns the startup cleanup task.
- `src-tauri/capabilities/default.json` — allowlist the five new commands.
- `src/changelog.json` — entry so the WhatsNewModal surfaces the feature post-update.

## On-disk layout

Per terminal `working_directory`:

```
<working_directory>/
  .claudeterminal/
    .gitignore           # single line: *
    pastes/
      paste-2026-05-10-1432.json
      errors-1102.log
      ...
```

Choosing a hidden top-level dir (versus modifying the project's own `.gitignore`) keeps the user's repo clean and avoids conflicting with project gitignore conventions. The dir and `.gitignore` are created on first write and the operation is idempotent.

## Data model

### Rust + TypeScript shared shape

```rust
struct PasteEntry {
    file_name: String,        // "paste-2026-05-10-1432.json"
    relative_path: String,    // forward-slash, ".claudeterminal/pastes/..."
    absolute_path: String,
    size_bytes: u64,
    created_at: String,       // ISO 8601
    detected_kind: String,    // "json" | "log" | "xml" | "text"
}
```

### Frontend store

```ts
type PasteHistoryEntry = PasteEntry & {
  preview: string; // first ~200 chars, for the recent list
};

type PasteStore = {
  byTerminal: Map<string, PasteHistoryEntry[]>; // most-recent first
  add(terminalId, entry, preview): void;
  remove(terminalId, fileName): void;
  list(terminalId): PasteHistoryEntry[];
  clearForTerminal(terminalId): void;
  hydrateFromDisk(terminalId): Promise<void>; // calls list_pastes once
};
```

On terminal restore (existing session-restore path), `hydrateFromDisk` runs once so retained files re-appear in the recent list.

### Filename rules

- Default base: `paste-YYYY-MM-DD-HHmm`.
- Extension auto-suggested from content sniffing: JSON parse succeeds → `.json`; balanced `<…>` tags → `.xml`; many `[INFO]/[ERROR]` or timestamped lines → `.log`; otherwise `.txt`. The user can override either field.
- Validation regex: `^[A-Za-z0-9._-]+$`. Reject `..`, path separators, drive letters, NUL.
- Collision: try `-2`, `-3`, … up to `-99`, then fall back to a UUID suffix.
- Path encoding for prompt substitution is always forward-slash regardless of OS (Claude Code's `@mention` accepts forward slashes on Windows and this avoids backslash-escaping in the user's typed prompt).

## UI / UX

### Drawer (right-side, ~520px wide)

```
┌───────────────────────────────────────────────┐
│  Paste as File                            [X] │
├───────────────────────────────────────────────┤
│  Target terminal:  [▼ active-tab-name      ]  │
│                                               │
│  Filename: [paste-2026-05-10-1432] .[json▼]   │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │   Monaco editor (auto-language)         │  │
│  │   Pasted content here…                  │  │
│  └─────────────────────────────────────────┘  │
│  Lines: 1,243   Size: 47.2 KB   Detected: JSON│
│                                               │
│  Prompt template:                             │
│  [Please look at @{path}                  ✎]  │
│                                               │
│  [ Discard ]      [ Save only ]    [ Send ▶ ] │
├───────────────────────────────────────────────┤
│  ▾ Recent pastes (this terminal)              │
│  • paste-2026-05-10-1340.json   2 min ago [↗] │
│  • errors-1102.log              17 min ago[↗] │
└───────────────────────────────────────────────┘
```

### Entry points

- Toolbar button on `TerminalStatusBar.tsx` — clipboard icon, tooltip `"Paste as file (Ctrl+Shift+V)"`.
- Global `Ctrl+Shift+V` registered in `useKeyboardShortcuts.ts` — opens drawer, pre-fills editor with current clipboard contents.
- Auto-detect toast (uses existing `ToastContainer`): when a single `onData` chunk crosses the threshold AND looks pasted (chunk arrived <16ms after the prior input event, i.e. not interactive typing), forward of the chunk to the PTY is suspended and a toast offers `[Save & Reference] [Paste anyway] [Don't ask again]`. Default action on Enter = Save & Reference.

### Behaviors

- **Send** — writes the file, types `<rendered-template>` into the target PTY via `writeToTerminal`. No trailing newline; user reviews and submits. Drawer closes. Toast: `"Sent to <terminal label>"`.
- **Save only** — writes the file and copies the relative path to the clipboard. Toast: `"Saved · path copied"`. Drawer closes.
- **Discard** — drawer closes; no disk write.
- **Recent pastes row click** — re-opens that paste's content in the editor (read-only by default; "Edit" button to unlock).
- **Recent pastes `[↗]` button** — re-sends to the active terminal without re-opening the drawer.

### Settings (new "Pastes" section in SettingsModal)

- **Auto-detect threshold** — bytes (default 4096) AND lines (default 50). Either limit triggers the toast.
- **Prompt template** — string with `{path}` placeholder. Default: `Please look at @{path}`.
- **Retention** — `delete-on-terminal-close` (default) | `keep-N-days` (with N input) | `keep-forever`.
- **Clear all pastes for this terminal** — manual button (uses `purge_pastes`).

## IPC commands

All five live in `commands.rs`, backed by `pastes.rs`:

```rust
#[command] async fn write_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    content: String,
    suggested_name: Option<String>,
    extension: String,
) -> Result<PasteEntry, String>

#[command] async fn list_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Vec<PasteEntry>, String>

#[command] async fn read_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<String, String>

#[command] async fn delete_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<(), String>

#[command] async fn purge_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String>
```

Each command resolves `terminal_id` → `working_directory` via `TerminalManager`, then computes `<cwd>/.claudeterminal/pastes/`. Every disk operation canonicalizes the resolved path and asserts it stays inside the pastes dir before touching anything. `file_name` is rejected unless it matches `^[A-Za-z0-9._-]+$`.

`pastes.rs` uses `std::fs` directly; the Tauri `fs` plugin is not involved, so no new fs-plugin scopes are required — only allowlisting these five commands in `capabilities/default.json`.

## Flows

### Explicit Send

1. User opens drawer (button, shortcut, or toast).
2. Monaco loads content (clipboard for shortcut path, captured chunk for toast path, empty for button path).
3. On Send: `invoke('write_paste', …)` → resolves with `PasteEntry`.
4. `pasteStore.add()` records the new entry at the head of the recent list.
5. Render the prompt template by substituting `{path}` with `relative_path`.
6. `terminalStore.writeToTerminal(targetId, renderedPrompt)`.
7. Drawer closes; toast confirms.

### Auto-detect interception (TerminalView.tsx)

1. xterm `onData` chunk arrives.
2. If chunk size > byte threshold OR newline count > line threshold AND time-since-prior-input < 16ms: suppress forward-to-PTY, show toast.
3. `[Save & Reference]` → open drawer pre-filled with the chunk and `targetTerminalId = this terminal`.
4. `[Paste anyway]` → forward the chunk unchanged; remember choice for this single paste only.
5. `[Don't ask again]` → flip the `autoDetectEnabled` setting off; forward the chunk.

### Cleanup

- `closeTerminal` in `terminalStore.ts` calls `invoke('purge_pastes', { terminalId })` after PTY kill, before map removal. Failures are logged but don't block close.
- App start: `main.rs` setup hook spawns a Tokio task that walks every distinct cwd known to the `workspaces` table in `database.rs`, applies the active retention policy, skipping any cwd that no longer exists or has no `.claudeterminal/pastes/` dir.

## Edge cases & error handling

- **Working dir gone** — `write_paste` returns `"Working directory <path> no longer exists"`; drawer surfaces inline; editor content is preserved.
- **Disk full / permission denied** — same inline-error path; nothing partial is sent.
- **Empty content** — Send and Save buttons disabled.
- **Very large content (>5 MB)** — warning banner `"This paste is X MB — Claude Code may truncate when reading"` but the operation is allowed.
- **Drawer collision** — only one drawer instance globally; opening it with new seed content while editor is dirty prompts `"Discard current draft?"`.
- **Target terminal died between open and Send** — `writeToTerminal` returns an error; toast surfaces it; the file is preserved on disk so the user can retry from the recent list.
- **Hostile `file_name`** (`../`, drive letter, separator, NUL) — rejected by regex before any filesystem call.

## Testing

### Rust unit tests (`pastes.rs`)

- Filename validation rejects `..`, `/`, `\`, `C:\…`, NUL, empty string.
- `write_paste` creates the dir and `.gitignore` if missing; idempotent on re-run.
- Collision suffixing: pre-create `paste-X.json`, write same name → returns `paste-X-2.json`.
- Path-escape canary: `file_name = "../../etc/passwd"` passed to `delete_paste` / `read_paste` returns `Err` and no filesystem mutation occurs (verified with `tempfile`-backed cwd).
- `purge_pastes` removes only files inside the pastes subdir; sibling files in `.claudeterminal/` and the project root are untouched.
- Retention pass: file mtimes back-dated via `filetime`; only files older than the retention window are removed.

### Frontend tests (Vitest + Testing Library)

- Drawer opens with seeded content from clipboard / toast / shortcut paths.
- Detected-kind sniffing: JSON, log, mixed → correct extension and Monaco language.
- Send / Save buttons disabled when content is empty.
- Prompt template substitution: `"Look at @{path}"` + returned relative path → exact string typed.
- Auto-detect threshold: synthetic large `onData` chunk triggers drawer; small chunk forwards to PTY.
- Mocked `write_paste` error renders inline error and keeps drawer open.

### Manual QA

1. Paste 200KB JSON → drawer → file written → `.gitignore` created → `@mention` typed in PTY.
2. Open same project in VS Code/IDE → confirm `.claudeterminal/` is git-ignored.
3. Close terminal (default retention) → `pastes/` is empty.
4. Switch retention to "Keep 7 days", manually back-date some files, restart app → old files survive, ancient ones purged on startup.
5. Write into a cwd without permission → drawer surfaces error, content preserved in editor.
6. Send via the target dropdown to a non-active terminal → text appears in correct PTY only.

## Rollout

- Single feature, single PR.
- Version bump `1.20.8` → `1.21.0` (minor — net-new user-facing feature).
- New `src/changelog.json` entry so the WhatsNewModal surfaces it after update.
- Add a screenshot of the drawer to `docs/` matching the style of `docs/main-view.png`.
- No DB migration. No new dependencies (Monaco and Framer Motion are already present).
- Existing users see no on-disk artifacts until they actually use the feature.
