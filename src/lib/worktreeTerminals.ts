import { useTerminalStore } from '../store/terminalStore';
import { samePath } from './races';

/** Every open terminal working in a worktree, by its task or its cwd (a
 *  same-worktree handoff, a shell or a script tab can share one). */
export function terminalsInWorktree(worktreePath: string): string[] {
  return Array.from(useTerminalStore.getState().terminals.values())
    .filter((t) => (t.config.task && samePath(t.config.task.worktreePath, worktreePath))
      || samePath(t.config.working_directory, worktreePath))
    .map((t) => t.config.id);
}
