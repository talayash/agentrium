---
name: feature-development-backend-frontend
description: Workflow command scaffold for feature-development-backend-frontend in agentrium.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-backend-frontend

Use this workflow when working on **feature-development-backend-frontend** in `agentrium`.

## Goal

Implements a new feature that requires both backend (Rust/Tauri) and frontend (React/TS) changes, including new components, hooks, and store updates.

## Common Files

- `src-tauri/src/commands.rs`
- `src-tauri/src/database.rs`
- `src-tauri/src/main.rs`
- `src-tauri/tauri.conf.json`
- `src/App.tsx`
- `src/components/*.tsx`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Modify or add Rust backend files (src-tauri/src/commands.rs, database.rs, main.rs, etc.)
- Update or add frontend React components in src/components/
- Update or add hooks in src/hooks/
- Update or add store files in src/store/
- Update src/App.tsx to wire up new UI or logic

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.