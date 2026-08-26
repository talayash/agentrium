# Refactor Clean

Find and safely remove dead code, unused imports, and unused dependencies.

## Instructions

Systematically find and remove dead code from the project. $ARGUMENTS

### Phase 1: Unused Imports (TypeScript)
1. Run `npx tsc --noEmit 2>&1` and look for unused import warnings
2. Search for imports that are never referenced in their file
3. Remove unused imports one file at a time
4. Verify `npx tsc --noEmit` still passes after each removal

### Phase 2: Unused Exports (TypeScript)
1. For each exported function/type/const in `src/`, search if it's imported anywhere
2. If an export has zero importers and is not an entry point, flag it
3. Remove confirmed dead exports
4. Verify build still passes

### Phase 3: Dead Code (Rust)
1. Run `cargo check 2>&1` in `src-tauri/` and look for dead_code warnings
2. Run `cargo clippy 2>&1` for additional unused code detection
3. Remove unused functions, structs, and imports
4. Verify `cargo check` still passes after each removal

### Phase 4: Unused Dependencies
1. Check `package.json` - search for each dependency's usage in `src/`
2. Check `Cargo.toml` - search for each dependency's usage in `src-tauri/src/`
3. Flag dependencies with zero references (excluding build/config deps)
4. Present list to user for confirmation before removing

### Rules
- **One removal at a time** - verify build passes after each
- **Never remove code you're not sure is dead** - if in doubt, flag it but don't remove
- **Don't touch test code** unless explicitly asked
- **Create a checkpoint first** if there are uncommitted changes

### Report
```
## Cleanup Report
- Unused imports removed: N
- Dead exports removed: N
- Dead Rust code removed: N
- Unused dependencies flagged: N
- Build status: ✅ PASS
```
