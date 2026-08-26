# Build Fix

Automatically detect and fix build errors with minimal changes.

## Instructions

Run the build and fix any errors found. Follow this process:

### Step 1: Detect Build System
Run these checks in order:
1. `cd src-tauri && cargo check 2>&1` - Rust compilation
2. `npx tsc --noEmit 2>&1` - TypeScript type checking
3. If a specific build command was mentioned in $ARGUMENTS, run that instead

### Step 2: Parse Errors
- Identify the FIRST error (fix one at a time)
- Note the file path, line number, and error code
- Read the relevant code to understand context

### Step 3: Apply Minimal Fix
- Make the SMALLEST change that resolves the error
- Do NOT refactor, restructure, or "improve" surrounding code
- Do NOT change unrelated code

### Step 4: Verify
- Re-run the same build command
- If fixed, move to next error
- If the fix created MORE errors than it resolved, REVERT and ask for help

### Step 5: Guardrails
- **Stop after 3 failed attempts** on the same error - explain what you tried
- **Stop if fix creates new errors** - revert and explain
- **Never change architecture** - if the fix requires restructuring, explain why and ask

### Step 6: Report
After all errors are fixed:
```
## Build Fix Report
- Errors fixed: N
- Files modified: [list]
- Build status: ✅ PASS / ❌ STILL FAILING
```
