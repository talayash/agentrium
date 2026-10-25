---
name: qa
description: Launch an isolated Agentrium desktop instance for local manual QA alongside the user's production client.
---

# Run Agentrium for local QA

Use this skill when asked to run, launch, or manually QA the desktop app. The desktop repository is the current directory; use its current branch and report any uncommitted changes before launch.

## Keep the production client isolated

The user's production Agentrium may be running with live sessions. Never stop or close any existing Agentrium / `claude-terminal.exe` process, never use port 5173, and never run bare `npm run tauri dev` or `npm run dev`.

Always set `AGENTRIUM_INSTANCE_ID=.qa` and pass all of these Tauri overrides together:

- identifier `com.claudeterminal.desktop.qa`
- product name `Agentrium QA`
- first window title `Agentrium QA`
- Vite `devUrl` on the selected QA port
- `beforeDevCommand` starts Vite on that same port with `--strictPort`

The instance suffix isolates its database and keychain service. Git repositories, files, worktrees, and Claude Code's own session data remain real; direct destructive QA at a scratch repo.

## Launch

Use port 5174 by default, checking it first with `Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue`. If occupied, choose the next free port above 5173; never kill a port owner. Install dependencies only if `node_modules` is absent.

On Windows PowerShell, write the Tauri JSON overrides to a temporary JSON file and pass that file to `--config`; quoting inline JSON through `npm` can strip its quotes. Set `$env:AGENTRIUM_INSTANCE_ID = '.qa'` in the same shell before running:

```powershell
npm run tauri dev -- --features devtools --config .qa.tauri.conf.json
```

Use the repository's `vite.qa.config.ts` for the QA server; it ignores `src-tauri/target`, whose locked executable otherwise causes Vite's watcher to exit with `EBUSY`. Set `beforeDevCommand` to `npm run dev -- --config vite.qa.config.ts --port <QA_PORT> --strictPort`. The Vite config is tracked and must remain in place while the server runs. Do not alter production ports or stop the watcher owner.

Wait for the Rust build and app launch. Verify using `Get-Process claude-terminal | Select-Object Id,MainWindowTitle,StartTime`; confirm a second process titled `Agentrium QA` exists and is newer than the pre-launch production process. If the isolated app cannot be confirmed, report the failure and stop without touching other processes.

Leave the QA instance running until the user says they are done. Tell them the branch, uncommitted changes, that the QA database and keychain are separate (they can retain data from previous QA runs), frontend edits hot-reload, Rust edits rebuild, and which external data remains real. Stop only the process/task started for QA when asked.

`tauri dev --features devtools` may rewrite `src-tauri/Cargo.toml` line endings or generated schema files. Report such side effects and do not commit them.
