import { Bot } from 'lucide-react';
import type { TaskInfo } from '../lib/tasks';
import { useAppStore } from '../store/appStore';
import { repairForWorktree, useCiRepairStore } from '../store/ciRepairStore';
import { Tooltip } from './ui/Tooltip';

/** Marks a task session started by "Fix with agent". Click opens the finish
 *  dialog, where the user reviews the changes and decides to merge them
 *  into the PR branch, keep the task, or discard it. Never pushes. */
export function CiRepairBadge({ terminalId, task }: { terminalId: string; task: TaskInfo }) {
  const repair = useCiRepairStore((s) => repairForWorktree(s.repairs, task.worktreePath));
  if (!repair) return null;
  const label = [
    `Fixing failing CI on pull request #${repair.prNumber}`,
    `Review the changes and run your checks, then finish the task to merge into ${repair.branch}.`,
    'Nothing is pushed automatically: push from the pull request session when ready.',
    'Click to review and finish',
  ].join('\n');
  return (
    <Tooltip label={label} multiline>
      <button
        type="button"
        onClick={() => useAppStore.getState().openFinishTask(terminalId, false)}
        aria-label={label.replace(/\n/g, ' ')}
        className="flex items-center gap-0.5 rounded-md text-[10.5px] px-1.5 h-[16px] font-medium flex-shrink-0 bg-amber-500/12 text-amber-400 hover:brightness-125 transition"
      >
        <Bot size={10} strokeWidth={2} className="flex-shrink-0" />
        <span className="tabular-nums">Fix CI #{repair.prNumber}</span>
      </button>
    </Tooltip>
  );
}
