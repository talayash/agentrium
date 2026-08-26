# Plan

Create a detailed implementation plan before writing any code.

## Instructions

You are about to plan the implementation of: $ARGUMENTS

Follow this process strictly:

### Step 1: Restate Requirements
- Restate what the user wants in your own words
- List specific acceptance criteria
- Identify any ambiguities - ask if unclear

### Step 2: Assess Current State
- Read relevant files in `src/` (frontend) and `src-tauri/src/` (backend)
- Identify ALL files that will need changes
- Note existing patterns to follow

### Step 3: Risk Assessment
Evaluate:
- Breaking changes to IPC contracts?
- New Zustand store fields needed?
- PTY/terminal lifecycle impact?
- Database schema changes?
- Windows-specific concerns?

### Step 4: Create Phased Plan
For each phase:
- Files to modify/create (exact paths)
- What changes in each file
- Dependencies between phases
- How to verify the phase works

### Step 5: Present Plan
Format as:
```
# Plan: [Feature Name]
## Requirements: ...
## Risk Assessment: ...
## Phase 1: [Name] - Files, Changes, Test
## Phase 2: [Name] - Files, Changes, Test
## Complexity: S/M/L/XL
```

**WAIT for user confirmation before implementing.** Ask: "Does this plan look good?"
