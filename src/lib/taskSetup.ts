import { invoke } from '@tauri-apps/api/core';
import type { RaceCheckResult } from './races';

/** Where a task or race launch is: creating worktrees, running the repo's
 *  setup command, or starting the agent terminals. */
export type LaunchPhase = 'worktree' | 'setup' | 'agent';

const TAIL_CHARS = 2000;

export function getTaskSetupCommand(repoPath: string): Promise<string | null> {
  return invoke<string | null>('get_task_setup_command', { repoPath });
}

export function setTaskSetupCommand(repoPath: string, command: string | null): Promise<void> {
  return invoke<void>('set_task_setup_command', { repoPath, command });
}

/** Runs the stored setup command in the task's worktree. `null` = none configured. */
export function runTaskSetup(worktreePath: string, runId: string): Promise<RaceCheckResult | null> {
  return invoke<RaceCheckResult | null>('run_task_setup', { worktreePath, runId });
}

export function cancelTaskSetup(runId: string): Promise<boolean> {
  return invoke<boolean>('cancel_task_setup', { runId });
}

/** Run id for contender `index` of a race whose launch uses `base`. */
export function raceSetupRunId(base: string, index: number): string {
  return `${base}-${index}`;
}

export function setupFailed(r: RaceCheckResult): boolean {
  return !(r.exit_code === 0 && !r.timed_out && !r.cancelled);
}

export function setupFailureMessage(r: RaceCheckResult): string {
  if (r.timed_out) return 'Setup command timed out.';
  if (r.cancelled) return 'Setup was cancelled.';
  const head = `Setup command failed (exit ${r.exit_code ?? 'unknown'}).`;
  const tail = r.output_tail.slice(-TAIL_CHARS);
  return tail ? `${head}\n\n${tail}` : head;
}
