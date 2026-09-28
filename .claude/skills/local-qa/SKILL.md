---
name: local-qa
description: How to run Agentrium locally for QA/manual verification alongside the user's running production client. Use whenever asked to run, start, launch, QA, smoke-test, or screenshot the desktop app. Contains the hard rule about never touching the running production instance or port 5173.
---

# Running Agentrium locally for QA

## The hard rule (never violate)

**The user runs their real Agentrium client on this machine, all day, with live
Claude Code sessions in it. It is production. It is their actual work.**

NEVER, under any circumstances, for any reason:

- Kill, stop, close, `Stop-Process`, `CloseMainWindow`, `taskkill`, or
  otherwise terminate a running `claude-terminal.exe` / `Agentrium` process.
- Take, free, or kill whatever is holding **port 5173**. That is the
  production client's dev port.
- Ask the user to close their client so your build can launch.
- Run bare `npm run tauri dev` or `npm run dev` in this repo. Both default to
  5173 and to the production app identifier, which collides.

There is no exception. Not "just this once", not "it's only a dev build", not
"the app restores sessions anyway", not if a launch fails and killing it would
be the quick fix. If QA seems to require stopping their client, **you are
using the wrong recipe - use the one below instead.**

If something still will not run after following this file, report that and
stop. Do not escalate to touching their process.

## Why a plain `tauri dev` cannot work here

Three separate collisions, all of which must be solved at once:

| Collision | Cause | Fix |
| --- | --- | --- |
| App never launches, exits code 0 | `tauri-plugin-single-instance` (`src-tauri/src/main.rs`) keys on the app identifier; a second launch just focuses the first and quits | override `identifier` |
| Port in use / hijacks their dev server | `vite.config.ts` pins `port: 5173, strictPort: true` | override port AND `build.devUrl` |
| Shares the production SQLite DB and keychain sign-in | data dir and keychain service default to the prod names | set `AGENTRIUM_INSTANCE_ID=.qa` |

Fixing only one of the first two is what causes the damage. Fix both.

### Isolating the database (know this before you QA)

**Always export `AGENTRIUM_INSTANCE_ID=.qa` before launching.** Rust reads it
through `crate::instance_suffix()` (`src-tauri/src/main.rs`) and appends it to:

- the SQLite data dir: `ClaudeTerminal.qa\claudeterminal.db` instead of the
  prod `ClaudeTerminal\claudeterminal.db` (`database.rs`), so profiles,
  workspaces, agents and session history start empty and stay separate;
- the keychain service: `com.claudeterminal.agentrium.auth.qa`
  (`credentials.rs`), so signing in or out in QA never touches the prod
  refresh token.

Without the variable the QA window opens on the user's real database. If you
forget it, close the QA window you launched and relaunch with it.

Do NOT use `APPDATA` / `LOCALAPPDATA` redirection instead. `directories`
resolves folders through `SHGetKnownFolderPath`, which ignores those
variables, so the redirect silently does nothing.

What is still shared with prod even with the suffix (all low risk, but know it):

- **Terminal log files** in `ClaudeTerminal\logs` (`commands.rs` hard-codes the
  unsuffixed dir). QA writes new, uniquely named files there and only deletes
  paths that its own DB points at, so prod logs are not touched.
- **`error_reporter` / `feedback` queues** and the **LSP download cache** also use
  the unsuffixed dir.
- **Real outside state**: git repos, worktrees, files on disk, and Claude Code's
  own `~/.claude` sessions. A QA terminal pointed at a real repo is a real
  terminal. Use a scratch folder for destructive flows (worktree removal,
  force push, session purge).

## The recipe

Run from `agentrium/`. Pick a QA port that is not 5173 (5174 is the default
choice; step up if it is taken).

```bash
QA_PORT=5174
export AGENTRIUM_INSTANCE_ID=.qa

npm run tauri dev -- \
  --features devtools \
  --config "{\"identifier\":\"com.claudeterminal.desktop.qa\",\"productName\":\"Agentrium QA\",\"build\":{\"devUrl\":\"http://localhost:$QA_PORT\",\"beforeDevCommand\":\"npm run dev -- --port $QA_PORT --strictPort\"}}"
```

Before picking the port, confirm nothing is listening on it:
`Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue`
returning nothing means it is free. If it is taken, use 5175, 5176, and so on.
Never 5173.

What each override buys you:

- `AGENTRIUM_INSTANCE_ID=.qa` - own SQLite DB and own keychain entry (see
  "Isolating the database" above).

- `identifier` -> `...desktop.qa` - single-instance no longer hands off, so a
  second window actually opens beside theirs.
- `productName` -> `Agentrium QA` - the window title tells you at a glance
  which one you are looking at. **Always check the title before interacting.**
- `devUrl` + `beforeDevCommand --port` - both halves must change together, or
  Tauri loads 5173 and you are driving their app's server.
First run recompiles Rust for the changed identifier - budget a few minutes.

## Verifying you are on the QA instance, not theirs

Before driving anything, confirm there are now two processes and that you know
which is which:

```powershell
Get-Process claude-terminal | Select-Object Id,MainWindowTitle,StartTime
```

The QA one is titled **Agentrium QA** and has the newer `StartTime`. If only
one process exists, the overrides did not take - re-read the recipe, do not
kill anything.

## Cleaning up

Stop ONLY the background task you started (`TaskStop` with your own task id),
or close the **Agentrium QA** window. Never target a PID you did not launch,
and never `Stop-Process -Name claude-terminal` - that name matches theirs too.

## Driving the update sheet and notification banner

Both are frontend-only, so DevTools (`--features devtools` is already in the
recipe) can drive them without any app source changes. Vite serves the store
modules in dev:

```js
const u = (await import('/src/store/updaterStore.ts')).useUpdaterStore;
const { toast, useToastStore } = await import('/src/store/toastStore.ts');

// update sheet: available / downloading / ready / error
u.setState({ status: 'available', notifiedVersion: '2.4.0',
  updateInfo: { version: '2.4.0', date: '2026-09-15', body: 'Release notes' },
  bannerDismissedVersion: null, bannerSnoozedUntil: null, skippedVersion: null });

u.setState({ status: 'downloading', downloadProgress: 61,
  downloadedBytes: 11200000, totalBytes: 18400000, bannerDismissedVersion: null });

u.setState({ status: 'ready', bannerDismissedVersion: null });   // Relaunch really relaunches
u.setState({ status: 'error', error: 'connection closed', bannerDismissedVersion: null });

// notifications - 4 at once crosses the collapse threshold
toast.success('Pushed to origin/master', '14 files changed across 2 commits');
toast.error('Push rejected', 'The remote has commits you do not have locally');
toast.warning('Worktree has uncommitted work', 'Switching branches may stash 6 files');
toast.info('Session restored', '4 terminals reattached');
useToastStore.getState().clearAll();
```

## Do not bother with a plain browser

`http://localhost:<port>` in an ordinary browser hits the error boundary:
`useWindowFocused.ts` calls `getCurrentWindow()`, which needs
`window.__TAURI_INTERNALS__`. Stubbing it is not worth the effort - use the
real window from the recipe above.
