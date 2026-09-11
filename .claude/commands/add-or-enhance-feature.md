---
name: add-or-enhance-feature
description: Workflow command scaffold for add-or-enhance-feature in agentrium.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-enhance-feature

Use this workflow when working on **add-or-enhance-feature** in `agentrium`.

## Goal

Implements a new feature or enhances an existing one, touching backend (Rust IPC), frontend components, and state stores.

## Common Files

- `src-tauri/src/commands.rs`
- `src-tauri/src/main.rs`
- `src-tauri/src/database.rs`
- `src-tauri/src/terminal.rs`
- `src/components/*.tsx`
- `src/hooks/*.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Add or update Rust IPC command(s) in src-tauri/src/commands.rs and possibly other backend files
- Add or update frontend React components in src/components/
- Update or create hooks in src/hooks/ if needed
- Update or create state stores in src/store/
- Wire up new UI in src/App.tsx or relevant container

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.