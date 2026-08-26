# Verify

Run a full verification pipeline to check project health.

## Instructions

Run ALL of the following checks and report results. Do not stop on first failure - run everything.

### 1. Rust Backend
```bash
cd src-tauri && cargo check 2>&1
```
```bash
cd src-tauri && cargo clippy -- -W clippy::all 2>&1
```
```bash
cd src-tauri && cargo fmt --check 2>&1
```

### 2. TypeScript Frontend
```bash
npx tsc --noEmit 2>&1
```

### 3. Build Test
```bash
npm run build 2>&1
```

### 4. IPC Contract Check
- Verify every `#[tauri::command]` in `commands.rs` is registered in `main.rs`
- Verify every `invoke()` call in `src/` references a valid command
- Check event name consistency between `emit()` and `listen()`

### 5. Security Quick Scan
- Search for `unwrap()` in production code paths (not tests)
- Search for hardcoded secrets/tokens/passwords
- Search for `eval()`, `innerHTML`, `dangerouslySetInnerHTML`
- Check that `cmd /C` calls properly escape user input

### 6. Diff Review (if uncommitted changes exist)
- Run `git diff` and review for:
  - Accidentally committed debug code (console.log, dbg!, println!)
  - TODO/FIXME without context
  - Large files that shouldn't be committed

## Report Format

```
## Verification Report

| Check | Status | Details |
|-------|--------|---------|
| Rust compile | ✅/❌ | ... |
| Clippy | ✅/❌ | ... |
| Rust format | ✅/❌ | ... |
| TypeScript | ✅/❌ | ... |
| Vite build | ✅/❌ | ... |
| IPC contracts | ✅/❌ | ... |
| Security scan | ✅/❌ | ... |
| Diff review | ✅/❌ | ... |

**Overall: PASS / FAIL (N issues)**
```
