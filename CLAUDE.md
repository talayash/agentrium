# CLAUDE.md

## Project Overview

**ClaudeTerminal** is a cross-platform desktop application (Windows and macOS) for managing multiple Claude Code CLI terminal instances from a unified interface. Built with Tauri 2.x (Rust backend) and React 18 (TypeScript frontend), it provides tabbed and grid views of parallel Claude Code sessions with PTY-based terminal emulation. The release workflow produces NSIS/MSI installers for Windows and `.dmg`/`.app` bundles for both Apple Silicon and Intel Macs.

Current version: **1.31.3**

## Tech Stack

- **Desktop framework**: Tauri 2.x
- **Backend**: Rust (edition 2021)
- **Frontend**: React 18 + TypeScript + Vite
- **Terminal emulation**: xterm.js (`@xterm/xterm`) with fit, search, and web-links addons
- **Styling**: Tailwind CSS + Framer Motion. Flat IntelliJ IDEA 2026.1 "New UI"–style design: a 5-step elevation ramp (`--elevation-0..4` CSS vars), `#3574F0` accent, Inter (UI) + JetBrains Mono (code). Supports dark/light/auto theme, user-set accent color, compact/comfortable/spacious density, UI font scale, and a "reduce motion" toggle that follows the OS `prefers-reduced-motion` setting until explicitly overridden. Text tokens target WCAG AA contrast. (Not glassmorphic — translucency is limited to overlay scrims.)
- **State management**: Zustand (persisted via `zustand/middleware/persist`)
- **Database**: SQLite via `rusqlite` (bundled) — stores profiles, workspaces, session history
- **PTY**: `portable-pty` crate for spawning Claude Code processes
- **Notifications**: `notify-rust` crate for native desktop notifications (Windows Toast and macOS NSUserNotification)
- **Auto-updates**: `tauri-plugin-updater` with signed releases from GitHub

## Project Structure

```
src/                          # React frontend
  App.tsx                     # Root component — layout, event listeners, setup wizard gate
  main.tsx                    # React entry point
  index.css                   # Tailwind base styles
  components/
    TitleBar.tsx              # Custom frameless window titlebar
    Sidebar.tsx               # Terminal list sidebar with search
    TerminalTabs.tsx          # Tab bar for switching terminals
    TerminalView.tsx          # xterm.js terminal renderer
    TerminalGrid.tsx          # Multi-terminal grid view (up to 8)
    TerminalSearch.tsx        # Search within terminal output
    NewTerminalModal.tsx      # Create terminal dialog
    ProfileModal.tsx          # Create/edit configuration profiles
    SettingsModal.tsx         # App settings (args, updates, shortcuts)
    HintsPanel.tsx            # Claude Code command hints reference
    SetupWizard.tsx           # First-run setup (Node.js/Claude Code detection)
    AutoUpdater.tsx           # In-app update UI
    WhatsNewModal.tsx         # Post-update release notes popup
  changelog.json              # Structured release notes data for What's New modal
  store/
    terminalStore.ts          # Terminal instances state (Map<id, {config, xterm}>)
    appStore.ts               # UI state (sidebar, grid, modals, settings)
    updaterStore.ts           # Auto-updater state
  hooks/
    useKeyboardShortcuts.ts   # Global keyboard shortcut handler
    useNotification.ts        # Desktop notification hook

src-tauri/                    # Rust backend
  src/
    main.rs                   # Tauri app setup, plugin registration, state init
    terminal.rs               # TerminalManager — PTY lifecycle (create, write, resize, close)
    commands.rs               # Tauri IPC commands (all #[command] handlers)
    config.rs                 # ConfigProfile struct, HintCategory/Hint structs, default hints
    database.rs               # SQLite database (profiles, workspaces, session_history tables)
  tauri.conf.json             # Tauri config (window, bundling, updater, plugins)
  Cargo.toml                  # Rust dependencies
  capabilities/default.json   # Tauri security capabilities

.claude/commands/
  publish.md                  # /publish slash command — full release workflow

.github/workflows/release.yml  # CI: build + publish GitHub releases (tag-triggered)
```

## Architecture

### Backend (Rust)

- `AppState` holds `Arc<Mutex<TerminalManager>>` and `Arc<Mutex<Database>>`, managed by Tauri
- `TerminalManager` uses `portable-pty` to spawn `cmd /C claude [args]` on Windows (or shell on other platforms)
- Each terminal gets a reader thread that forwards PTY output via `mpsc::channel` to a Tokio task, which emits `terminal-output` events to the frontend
- When the PTY reader loop ends (process exit), a `terminal-finished` event is emitted
- All Tauri commands are async and defined in `commands.rs`
- Shell commands (`node`, `npm`, `claude`) are wrapped via `cmd /C` on Windows with `CREATE_NO_WINDOW` flag

### Frontend (React)

- `App.tsx` listens for `terminal-output` and `terminal-finished` Tauri events
- Terminal state uses a `Map<string, TerminalInstance>` in Zustand (not persisted — terminals are ephemeral)
- App state (sidebar, grid, settings) is persisted to localStorage via Zustand persist middleware
- Each `TerminalView` creates an xterm.js instance and wires keyboard input to `write_to_terminal` IPC
- Grid mode supports up to 8 terminals with auto-layout calculation in `getOptimalLayout()`

### IPC Commands

Key Tauri commands exposed to the frontend:
- `create_terminal` / `close_terminal` / `write_to_terminal` / `resize_terminal`
- `update_terminal_label` / `update_terminal_nickname`
- `save_profile` / `get_profiles` / `delete_profile`
- `save_workspace` / `load_workspace`
- `check_system_requirements` / `install_claude_code`
- `get_claude_version` / `check_claude_update` / `update_claude_code`
- `get_hints` / `send_notification` / `open_external_url`

## Development

### Prerequisites

- Node.js v22+ (LTS; v18/v20 are EOL — CI builds on 22)
- Rust (latest stable via rustup)
- Visual Studio Build Tools (Windows)

### Commands

```bash
npm install          # Install frontend dependencies
npm run tauri dev    # Run in development mode (hot-reload)
npm run tauri build  # Build production installers (NSIS + MSI)
```

Build output: `src-tauri/target/release/bundle/nsis/` and `src-tauri/target/release/bundle/msi/`

### Publishing a Release

Use the `/publish` command (e.g., `/publish 1.6.0`) to run the full release workflow. This is defined in `.claude/commands/publish.md` and automates:

1. **Version bump** in all four files that contain the version:
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `README.md` → version badge + download link filenames
2. **Cargo.lock update** via `cargo check` in `src-tauri/`
3. **Commit** with message `Release v{VERSION}`
4. **Tag** with `v{VERSION}`
5. **Push** commit + tag to `origin master`
6. GitHub Actions (`release.yml`) then builds installers, signs them, and publishes the release
7. Existing users receive the update via the in-app auto-updater

### Manual Release Process

If not using `/publish`, the same steps can be done manually:
1. Bump version in all four files listed above
2. Run `cargo check` in `src-tauri/` to update `Cargo.lock`
3. Commit, tag with `v{VERSION}`, push commit + tag
4. The `Release` workflow triggers on `v*` tags
5. Signing uses `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets
6. The updater endpoint: `https://github.com/talayash/claude-terminal/releases/latest/download/latest.json`

## Key Patterns

- **Error handling in Rust**: Commands return `Result<T, String>` — errors are string-mapped via `.map_err(|e| e.to_string())`. Every `#[command]` body is wrapped in `wrap_cmd("name", ...)`, which reports `Err` results to telemetry. Errors caused by user input or environment (validation, git push/pull rejections, file-too-large) must be returned via `error_reporter::user_err(...)` — the UI still sees the plain message, but telemetry is skipped. Background threads/tasks outside `wrap_cmd` report real failures via `error_reporter::report_bg(kind, message)`; use `report_blocking` only when the process is about to exit (panic hook, shutdown path).
- **Error handling in the frontend** (pick by call-site type, never `console.error`-only — that silently deletes telemetry the global `unhandledrejection` handler would have produced):
  - *User-initiated action* → `.catch(err => { toast.error(...); reportInvokeFailure('<command_name>', err); })` from `src/lib/errorReporter.ts`. A silent failure here is a user-facing bug.
  - *Background poller / best-effort cleanup* → `.catch(() => {})` with a one-line comment saying why it's safe to swallow.
  - *Clipboard* → always `copyText()` / `readClipboardText()` from `src/lib/clipboard.ts`, never bare `navigator.clipboard` (WebView2 focus gating).
- **Tauri events**: Backend emits `terminal-output` (with `{id, data}`) and `terminal-finished` (with `{id}`)
- **Frontend invoke pattern**: `invoke<ReturnType>('command_name', { param })` from `@tauri-apps/api/core`
- **Window**: Frameless (`decorations: false`, `transparent: true`) with custom `TitleBar` component
- **Grid layouts**: `GridLayout` type is a union of strings like `'2x2'`, `'2x3'`, etc.
- **Unread indicator**: Terminals receiving output while not active are tracked in `unreadTerminalIds` Set
- **Database location**: `ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")` → data dir → `claudeterminal.db`
