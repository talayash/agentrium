---
name: rust-patterns
description: Rust/Tauri patterns and best practices for ClaudeTerminal backend
---

# Rust Patterns for ClaudeTerminal

## Error Handling
- Commands return `Result<T, String>` - use `.map_err(|e| e.to_string())`
- Never `.unwrap()` in production - use `?` operator
- Use `anyhow` for internal errors, convert to String at IPC boundary

## Thread Safety
- `AppState` uses `Arc<Mutex<T>>` - lock, use, drop quickly
- Never hold a Mutex lock across `.await` points
- PTY reader threads use `mpsc::channel` to communicate with Tokio tasks

## Tauri Commands
- All commands are `async` with `#[tauri::command]`
- Access state via `tauri::State<'_, AppState>`
- Register every command in `main.rs` invoke_handler

## Windows Specifics
- Wrap shell commands with `cmd /C`
- Use `CREATE_NO_WINDOW` flag on process spawns
- Test path handling with backslashes

## PTY Lifecycle
- Spawn → reader thread → mpsc channel → Tokio task → emit events
- On close: signal reader thread, join, close channel, emit `terminal-finished`
- Always clean up resources even on error paths
