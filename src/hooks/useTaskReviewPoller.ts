// Observes task worktrees of open sessions and raises one "Ready to merge"
// attention item per task when its branch has commits, nothing is left
// uncommitted and the agent has settled. Mounted once in App.tsx. It only
// reads git state through get_task_status; merging stays in FinishTaskDialog.

import { useEffect } from 'react';
import { useTerminalStore, type TerminalInstance } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { useTaskObservationStore } from '../store/taskObservationStore';
import { getTaskStatus, type TaskStatus } from '../lib/tasks';
import { isReadyToMerge } from '../lib/reviewQueue';
import { sessionDisplayName } from '../lib/sessionContext';
import type { SessionState } from '../lib/terminalState';

export const TASK_POLL_MS = 60_000;

/** Race contenders are decided in the compare view, not one by one. */
function reviewableTask(t: TerminalInstance | undefined): t is TerminalInstance & { config: { task: NonNullable<TerminalInstance['config']['task']> } } {
  return !!t?.config.task && !t.config.task.raceId && !t.scriptParentId && !t.isShellTerminal;
}

/** The signature of a ready task; a new item is raised only when it changes,
 *  so a dismissed item stays dismissed until new commits land. */
export function readySignature(status: TaskStatus): string {
  return `${status.ahead}|${status.changed_files.join('\n')}`;
}

export function mergeDetail(status: TaskStatus): string {
  const files = status.changed_files.length;
  return `${status.ahead} commit${status.ahead === 1 ? '' : 's'} on ${status.task.branch} (${files} file${files === 1 ? '' : 's'}) ready to merge into ${status.task.baseBranch}.`;
}

// Busy may be a repaint (opening, resizing or re-theming a session), so it
// never clears an item; real new work shows up as uncommitted changes.
const unsettled = (state: SessionState | undefined) => state === 'busy' || state === 'waiting';

export function subscribeTaskReview(intervalMs = TASK_POLL_MS): () => void {
  const signatures = new Map<string, string>();
  const inFlight = new Set<string>();
  const again = new Set<string>();
  let stopped = false;

  const clear = (id: string) => {
    if (signatures.delete(id)) useAttentionStore.getState().dismiss(id, 'task');
  };

  const decide = (id: string, status: TaskStatus) => {
    const { terminals, terminalStates } = useTerminalStore.getState();
    const t = terminals.get(id);
    if (!reviewableTask(t)) return;
    if (!isReadyToMerge(status) || t.config.status === 'Error') { clear(id); return; }
    if (unsettled(terminalStates.get(id))) return;
    const sig = readySignature(status);
    if (signatures.get(id) === sig) return;
    signatures.set(id, sig);
    useAttentionStore.getState().put({
      terminalId: id, targetId: id, kind: 'merge', title: sessionDisplayName(t), detail: mergeDetail(status),
    });
  };

  const refresh = async (id: string) => {
    if (inFlight.has(id)) { again.add(id); return; }
    const t = useTerminalStore.getState().terminals.get(id);
    if (!reviewableTask(t)) return;
    inFlight.add(id);
    try {
      const status = await getTaskStatus(t.config.task.worktreePath);
      if (stopped || !useTerminalStore.getState().terminals.has(id)) return;
      useTaskObservationStore.getState().set(id, { status });
      decide(id, status);
    } catch (err) {
      // Background poll: a finished or hand-deleted worktree, or git missing.
      // The queue shows "status unavailable"; the next tick retries.
      if (!stopped) useTaskObservationStore.getState().set(id, { error: String(err) });
    } finally {
      inFlight.delete(id);
      if (again.delete(id) && !stopped) void refresh(id);
    }
  };

  const refreshAll = () => {
    for (const [id, t] of useTerminalStore.getState().terminals) if (reviewableTask(t)) void refresh(id);
  };

  const unsubscribe = useTerminalStore.subscribe((state, previous) => {
    if (state.terminals === previous.terminals && state.terminalStates === previous.terminalStates) return;
    const ids = new Set(state.terminals.keys());
    useTaskObservationStore.getState().retain(ids);
    for (const id of [...signatures.keys()]) if (!ids.has(id)) signatures.delete(id);
    for (const [id, t] of state.terminals) {
      if (!reviewableTask(t)) continue;
      const before = previous.terminals.get(id);
      const inferred = state.terminalStates.get(id);
      const changed = !before || before.config.status !== t.config.status || previous.terminalStates.get(id) !== inferred;
      if (!changed || unsettled(inferred)) continue;
      void refresh(id);
    }
  });
  refreshAll();
  const timer = setInterval(refreshAll, intervalMs);
  return () => { stopped = true; unsubscribe(); clearInterval(timer); };
}

export function useTaskReviewPoller(): void {
  useEffect(() => subscribeTaskReview(), []);
}
