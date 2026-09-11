---
name: release-version-bump
description: Workflow command scaffold for release-version-bump in agentrium.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /release-version-bump

Use this workflow when working on **release-version-bump** in `agentrium`.

## Goal

Prepares and publishes a new release version of the project, updating version numbers, changelogs, and relevant configuration files.

## Common Files

- `CLAUDE.md`
- `README.md`
- `package.json`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update CLAUDE.md with new version and/or release notes
- Update README.md if necessary
- Update package.json version
- Update src-tauri/Cargo.lock and src-tauri/Cargo.toml for Rust dependencies
- Update src-tauri/tauri.conf.json for Tauri config

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.