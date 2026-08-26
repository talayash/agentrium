# TDD

Implement a feature using strict Test-Driven Development.

## Instructions

Implement the following using TDD: $ARGUMENTS

### The TDD Cycle

Follow this cycle strictly. Do NOT skip steps.

#### 🔴 RED - Write a Failing Test
1. Write a test that describes the desired behavior
2. Run the test - it MUST fail
3. If it passes, the test is wrong or the feature already exists

#### 🟢 GREEN - Make It Pass
1. Write the MINIMUM code to make the test pass
2. Do not write more code than needed
3. Run the test - it MUST pass now

#### 🔵 REFACTOR - Clean Up
1. Refactor the implementation (not the test) for clarity
2. Run the test - it MUST still pass
3. No behavior changes during refactor

### Repeat
Continue the RED → GREEN → REFACTOR cycle for each piece of functionality.

### For This Project

**Frontend tests** (if applicable):
- Use Vitest for unit tests
- Test React components with @testing-library/react
- Test Zustand stores directly

**Backend tests** (if applicable):
- Use `#[cfg(test)]` modules in Rust
- Test command logic without Tauri runtime where possible
- Use mock implementations for Database/TerminalManager

### Checkpoints
Create a git checkpoint after each completed GREEN phase:
```bash
git add -A && git commit -m "checkpoint: [test description] - GREEN"
```

### Report
After implementation:
```
## TDD Report
- Tests written: N
- All passing: ✅/❌
- Cycles completed: N
- Coverage: [estimate]
```
