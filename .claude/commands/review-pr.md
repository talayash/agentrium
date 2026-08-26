# Review a pull request

Review the PR at $ARGUMENTS (a PR number or URL). Fetch the diff and changed files, then check for:

## Rust Backend
1. No `.unwrap()` in production code paths - use `.map_err()` or `?` operator
2. Proper `Arc<Mutex<>>` usage for shared state access
3. PTY reader threads properly handle process exit
4. `CREATE_NO_WINDOW` flag used for spawned processes on Windows
5. All `#[tauri::command]` handlers return `Result<T, String>`

## React Frontend
1. xterm.js `Terminal` instances are disposed on unmount
2. Tauri event listeners return unlisten functions that are called on cleanup
3. No stale closures in Zustand selectors or useEffect hooks
4. Consistent dark glassmorphic Tailwind classes

## IPC Consistency
1. Every new `invoke()` call has a matching registered command in `main.rs`
2. Parameter names and types match between Rust and TypeScript
3. Error handling uses try/catch around invoke calls

## General
1. No new capabilities added to `capabilities/default.json` without justification
2. Version numbers consistent across `package.json`, `Cargo.toml`, `tauri.conf.json`
3. No secrets or credentials committed

Provide a summary with findings grouped by severity (blocking, warning, nit).
