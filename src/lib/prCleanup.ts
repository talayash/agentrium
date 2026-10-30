import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { terminalPrTarget } from './pullRequestActions';
import { getTaskStatus } from './tasks';
import { reportInvokeFailure } from './errorReporter';

export interface CleanupCandidate {
  terminalId: string;
  busy: boolean;
  /** Task worktree the session runs in, null for a plain session. */
  worktreePath: string | null;
  uncommitted: number;
}

export interface CleanupPlan {
  close: string[];
  removeWorktrees: string[];
  skipped: { terminalId: string; reason: string }[];
}

/** Decide what a PR cleanup may touch. A session is skipped while its agent
 *  works or its worktree has uncommitted changes; a worktree is removed only
 *  when every session in it is closing. */
export function planCleanup(candidates: CleanupCandidate[]): CleanupPlan {
  const plan: CleanupPlan = { close: [], removeWorktrees: [], skipped: [] };
  const blocked = new Set<string>();
  for (const c of candidates) {
    const reason = c.busy ? 'Agent is still working' : c.uncommitted > 0 ? 'Uncommitted changes in the worktree' : null;
    if (reason) {
      plan.skipped.push({ terminalId: c.terminalId, reason });
      if (c.worktreePath) blocked.add(c.worktreePath);
    } else {
      plan.close.push(c.terminalId);
    }
  }
  for (const c of candidates) {
    if (c.worktreePath && !blocked.has(c.worktreePath) && !plan.removeWorktrees.includes(c.worktreePath)) {
      plan.removeWorktrees.push(c.worktreePath);
    }
  }
  return plan;
}

/** Close every session of a PR, then remove the task worktrees that no longer
 *  have a session, keeping the branch. Never throws. */
export async function cleanUpPrSessions(prKey: string): Promise<CleanupPlan> {
  const { terminals, terminalStates } = useTerminalStore.getState();
  const candidates: CleanupCandidate[] = [];
  const unchecked: CleanupPlan['skipped'] = [];
  for (const id of terminals.keys()) {
    if (terminalPrTarget(id)?.key !== prKey) continue;
    const worktreePath = terminals.get(id)?.config.task?.worktreePath ?? null;
    let uncommitted = 0;
    if (worktreePath) {
      try {
        uncommitted = (await getTaskStatus(worktreePath)).uncommitted.length;
      } catch {
        // Cannot prove the worktree is clean, so leave this session alone.
        unchecked.push({ terminalId: id, reason: 'Could not check the worktree' });
        continue;
      }
    }
    candidates.push({ terminalId: id, busy: terminalStates.get(id) === 'busy', worktreePath, uncommitted });
  }
  const plan = planCleanup(candidates);
  plan.skipped.push(...unchecked);
  // A worktree shared with a session we could not check must stay.
  const uncheckedPaths = new Set(unchecked.map(u => terminals.get(u.terminalId)?.config.task?.worktreePath));
  plan.removeWorktrees = plan.removeWorktrees.filter(p => !uncheckedPaths.has(p));

  // Close first: an open terminal holds the worktree as its cwd (Windows lock).
  const closed: string[] = [];
  const stillOpen = new Set<string | null | undefined>();
  for (const id of plan.close) {
    try {
      await useTerminalStore.getState().closeTerminal(id);
      closed.push(id);
      useAttentionStore.getState().dismiss(id, 'pr');
    } catch (err) {
      reportInvokeFailure('close_terminal', err);
      plan.skipped.push({ terminalId: id, reason: 'Could not close the session' });
      stillOpen.add(terminals.get(id)?.config.task?.worktreePath);
    }
  }
  plan.close = closed;
  // Never remove a worktree whose session is still open.
  plan.removeWorktrees = plan.removeWorktrees.filter(p => !stillOpen.has(p));
  for (const worktreePath of plan.removeWorktrees) {
    try {
      await invoke('finish_task', { worktreePath, action: { kind: 'keep' } });
    } catch (err) {
      reportInvokeFailure('finish_task', err);
      plan.skipped.push({ terminalId: '', reason: `Could not remove ${worktreePath}: ${String(err)}` });
    }
  }
  return plan;
}

export function cleanupToastMessage(prNumber: number, plan: CleanupPlan): string {
  const kept = plan.skipped.filter(s => s.terminalId).length;
  return `Cleaned up ${plan.close.length} session(s) for PR #${prNumber}${kept ? `, kept ${kept}` : ''}`;
}
