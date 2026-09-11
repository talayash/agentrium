---
name: verification-loop
description: Full build/type/lint/security verification pipeline for Agentrium
---

# Verification Loop

A systematic verification pipeline that checks all aspects of project health before commits or releases.

## When to Use

- Before committing significant changes
- Before creating a release
- After resolving merge conflicts
- When `/verify` command is invoked

## Pipeline Phases

### Phase 1: Rust Backend Compilation
```bash
cd src-tauri && cargo check 2>&1
```
- Must compile with zero errors
- Warnings are acceptable but should be noted

### Phase 2: Rust Linting
```bash
cd src-tauri && cargo clippy -- -W clippy::all 2>&1
```
- All clippy warnings should be addressed
- `#[allow(clippy::...)]` only with justification

### Phase 3: Rust Formatting
```bash
cd src-tauri && cargo fmt --check 2>&1
```
- Must pass with no formatting changes needed

### Phase 4: TypeScript Type Check
```bash
npx tsc --noEmit 2>&1
```
- Zero type errors
- Strict mode compliance

### Phase 5: Frontend Build
```bash
npm run build 2>&1
```
- Vite production build must succeed
- Check for bundle size warnings

### Phase 6: IPC Contract Validation
- Every `#[tauri::command]` in `commands.rs` registered in `main.rs`
- Every `invoke()` in frontend matches a registered command
- Event names consistent between `emit()` and `listen()`

### Phase 7: Security Quick Scan
- No `.unwrap()` in production Rust code (use `?` or `.map_err()`)
- No hardcoded secrets/tokens
- No `eval()` or `innerHTML` in frontend
- No `console.log` with sensitive data

## Report Template

```
| Phase | Status | Duration | Notes |
|-------|--------|----------|-------|
| Rust compile | ✅/❌ | Xs | |
| Clippy | ✅/❌ | Xs | |
| Formatting | ✅/❌ | Xs | |
| TypeScript | ✅/❌ | Xs | |
| Vite build | ✅/❌ | Xs | |
| IPC contracts | ✅/❌ | - | |
| Security scan | ✅/❌ | - | |

**Result: PASS / FAIL**
```
