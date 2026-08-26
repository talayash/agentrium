---
name: tdd-workflow
description: Test-Driven Development workflow with RED-GREEN-REFACTOR cycle and git checkpoints
---

# TDD Workflow

## The Cycle

1. **RED** - Write a failing test first
2. **GREEN** - Write minimum code to pass
3. **REFACTOR** - Clean up, tests must still pass

## Rules

- Never write production code without a failing test
- Each GREEN phase gets a git checkpoint
- Refactor must not change behavior
- Stop if tests fail after refactor - fix before continuing
