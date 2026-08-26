# Checkpoint

Create a git checkpoint to safely save current progress.

## Instructions

Create a lightweight checkpoint commit so you can safely continue working with the ability to roll back.

### Process

1. **Check current state**:
   ```bash
   git status
   git diff --stat
   ```

2. **Stage all changes**:
   ```bash
   git add -A
   ```

3. **Create checkpoint commit**:
   - Message format: `checkpoint: $ARGUMENTS` (or `checkpoint: WIP` if no arguments)
   - These are meant to be squashed later

4. **Confirm**:
   ```
   ✅ Checkpoint created: [commit hash]
   Files: [count] changed
   To roll back: git reset --soft HEAD~1
   ```

### Notes
- Checkpoints are for LOCAL safety only - do not push
- Use `git reset --soft HEAD~1` to undo the checkpoint and continue working
- When done, squash checkpoint commits into a proper commit with `/publish` or manual squash
