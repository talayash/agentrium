---
name: agentrium-conventions
description: Development conventions and patterns for Agentrium (formerly claude-terminal). TypeScript Vite project with freeform commits.
---

# Agentrium Conventions

> Generated from [talayash/agentrium](https://github.com/talayash/agentrium) on 2026-03-24 (originally as claude-terminal)

## Overview

This skill teaches Claude the development patterns and conventions used in Agentrium (formerly claude-terminal).

## Tech Stack

- **Primary Language**: TypeScript
- **Framework**: Vite
- **Architecture**: type-based module organization
- **Test Location**: separate

## When to Use This Skill

Activate this skill when:
- Making changes to this repository
- Adding new features following established patterns
- Writing tests that match project conventions
- Creating commits with proper message format

## Commit Conventions

Follow these commit message conventions based on 83 analyzed commits.

### Commit Style: Free-form Messages

### Prefixes Used

- `feat`

### Message Guidelines

- Average message length: ~49 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
feat: add claude-terminal ECC bundle (.claude/commands/add-or-enhance-feature.md)
```

*Commit message example*

```text
docs: Update README for v1.2.0
```

*Commit message example*

```text
Fix: Use correct Rust toolchain action in release workflow
```

*Commit message example*

```text
Release v1.17.1
```

*Commit message example*

```text
Merge remote-tracking branch 'origin/feature/advanced-claude-features'
```

*Commit message example*

```text
Merge pull request #8 from talayash/ecc-tools/claude-terminal-1774384938639
```

*Commit message example*

```text
Release v1.17.0
```

*Commit message example*

```text
Merge pull request #7 from talayash/feature/advanced-claude-features
```

## Architecture

### Project Structure: Single Package

This project uses **type-based** module organization.

### Source Layout

```
src/
├── components/
├── fonts/
├── hooks/
├── store/
```

### Entry Points

- `src/App.tsx`
- `src/main.tsx`

### Configuration Files

- `.github/workflows/release.yml`
- `package.json`
- `tailwind.config.js`
- `tsconfig.json`
- `vite.config.ts`

### Guidelines

- Group code by type (components, services, utils)
- Keep related functionality in the same type folder
- Avoid circular dependencies between type folders

## Code Style

### Language: TypeScript

### Naming Conventions

| Element | Convention |
|---------|------------|
| Files | camelCase |
| Functions | camelCase |
| Classes | PascalCase |
| Constants | SCREAMING_SNAKE_CASE |

### Import Style: Relative Imports

### Export Style: Named Exports


*Preferred import style*

```typescript
// Use relative imports
import { Button } from '../components/Button'
import { useAuth } from './hooks/useAuth'
```

*Preferred export style*

```typescript
// Use named exports
export function calculateTotal() { ... }
export const TAX_RATE = 0.1
export interface Order { ... }
```

## Error Handling

### Error Handling Style: Error Boundaries

React **Error Boundaries** are used for graceful UI error handling.


## Common Workflows

These workflows were detected from analyzing commit patterns.

### Feature Development

Standard feature implementation workflow

**Frequency**: ~16 times per month

**Steps**:
1. Add feature implementation
2. Add tests for feature
3. Update documentation

**Files typically involved**:
- `src/*`
- `src/components/*`
- `src/hooks/*`

**Example commit sequence**:
```
Add File Changes panel for per-terminal git status
Release v1.8.0
Release v1.8.1
```

### Release Version Bump

Prepares and publishes a new release version of the project, updating version numbers, changelogs, and relevant configuration files.

**Frequency**: ~4 times per month

**Steps**:
1. Update CLAUDE.md with new version and/or release notes
2. Update README.md if necessary
3. Update package.json version
4. Update src-tauri/Cargo.lock and src-tauri/Cargo.toml for Rust dependencies
5. Update src-tauri/tauri.conf.json for Tauri config
6. Update src/changelog.json with new entry

**Files typically involved**:
- `CLAUDE.md`
- `README.md`
- `package.json`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src/changelog.json`

**Example commit sequence**:
```
Update CLAUDE.md with new version and/or release notes
Update README.md if necessary
Update package.json version
Update src-tauri/Cargo.lock and src-tauri/Cargo.toml for Rust dependencies
Update src-tauri/tauri.conf.json for Tauri config
Update src/changelog.json with new entry
```

### Feature Development Backend Frontend

Implements a new feature that requires both backend (Rust/Tauri) and frontend (React/TS) changes, including new components, hooks, and store updates.

**Frequency**: ~3 times per month

**Steps**:
1. Modify or add Rust backend files (src-tauri/src/commands.rs, database.rs, main.rs, etc.)
2. Update or add frontend React components in src/components/
3. Update or add hooks in src/hooks/
4. Update or add store files in src/store/
5. Update src/App.tsx to wire up new UI or logic
6. Update configuration files if needed (e.g., src-tauri/tauri.conf.json)

**Files typically involved**:
- `src-tauri/src/commands.rs`
- `src-tauri/src/database.rs`
- `src-tauri/src/main.rs`
- `src-tauri/tauri.conf.json`
- `src/App.tsx`
- `src/components/*.tsx`
- `src/hooks/*.ts`
- `src/store/*.ts`

**Example commit sequence**:
```
Modify or add Rust backend files (src-tauri/src/commands.rs, database.rs, main.rs, etc.)
Update or add frontend React components in src/components/
Update or add hooks in src/hooks/
Update or add store files in src/store/
Update src/App.tsx to wire up new UI or logic
Update configuration files if needed (e.g., src-tauri/tauri.conf.json)
```

### Merge Feature Branch

Merges a feature branch into the main branch, typically bringing in multiple new or updated files for a cohesive feature or bundle.

**Frequency**: ~2 times per month

**Steps**:
1. Merge branch and resolve conflicts if any
2. Bring in multiple new or updated files (skills, commands, config, agents, etc.)
3. Update documentation and config files as needed

**Files typically involved**:
- `.agents/skills/claude-terminal/SKILL.md`
- `.agents/skills/claude-terminal/agents/openai.yaml`
- `.claude/commands/*.md`
- `.claude/ecc-tools.json`
- `.claude/homunculus/instincts/inherited/*.yaml`
- `.claude/identity.json`
- `.claude/skills/claude-terminal/SKILL.md`
- `.codex/AGENTS.md`
- `.codex/agents/*.toml`
- `.codex/config.toml`

**Example commit sequence**:
```
Merge branch and resolve conflicts if any
Bring in multiple new or updated files (skills, commands, config, agents, etc.)
Update documentation and config files as needed
```


## Best Practices

Based on analysis of the codebase, follow these practices:

### Do

- Use camelCase for file names
- Prefer named exports

### Don't

- Don't deviate from established patterns without discussion

---

*This skill was auto-generated by [ECC Tools](https://ecc.tools). Review and customize as needed for your team.*
