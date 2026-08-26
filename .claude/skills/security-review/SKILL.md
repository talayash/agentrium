---
name: security-review
description: Security audit checklist and patterns for Tauri desktop apps with PTY spawning
---

# Security Review Skill

## Threat Surface for ClaudeTerminal

1. **PTY Command Injection** - user input → xterm.js → IPC → PTY
2. **IPC Boundary** - frontend can invoke any registered command
3. **Process Spawning** - `cmd /C` wrapping needs proper escaping
4. **File System** - workspace paths from user input
5. **Auto-updater** - must verify signed releases
6. **SQLite** - parameterized queries only

## Quick Checklist

- [ ] No `.unwrap()` in production Rust paths
- [ ] No hardcoded secrets/tokens/passwords
- [ ] No `eval()`, `innerHTML`, `dangerouslySetInnerHTML`
- [ ] All IPC commands validate inputs
- [ ] `cmd /C` calls escape user strings
- [ ] SQLite uses parameterized queries
- [ ] Tauri capabilities are minimal
- [ ] CSP configured in tauri.conf.json
- [ ] Auto-updater verifies signatures
