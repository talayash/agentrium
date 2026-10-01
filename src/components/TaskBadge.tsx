import { GitBranch } from 'lucide-react';
import type { TaskInfo } from '../lib/tasks';
import { useTerminalStore } from '../store/terminalStore';
import { Tooltip } from './ui/Tooltip';

/** Task branch plus commits ahead/behind its base, for cards and the header. */
export function TaskBadge({ terminalId, task, compact = false }: { terminalId: string; task: TaskInfo; compact?: boolean }) {
  const div = useTerminalStore((s) => s.taskDivergence.get(terminalId));
  const shortBranch = task.branch.replace(/^agentrium\//, '');
  const counts = div && (div.ahead > 0 || div.behind > 0)
    ? `${div.ahead > 0 ? `↑${div.ahead}` : ''}${div.behind > 0 ? `↓${div.behind}` : ''}`
    : '';
  const label = `Task branch ${task.branch} from ${task.baseBranch}`
    + (div ? `\n${div.ahead} ahead, ${div.behind} behind ${task.baseBranch}` : '');
  return (
    <Tooltip label={label} multiline>
      <span
        className={`flex items-center gap-0.5 rounded-md bg-purple-500/12 text-purple-400 font-medium flex-shrink-0 ${
          compact ? 'text-[10px] px-1 h-[15px] max-w-[130px]' : 'text-[10.5px] px-1.5 h-[16px] max-w-[200px]'
        }`}
        tabIndex={0}
        aria-label={label}
      >
        <GitBranch size={compact ? 9 : 10} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">{shortBranch}</span>
        {counts && <span className="tabular-nums text-purple-300/90 ml-0.5">{counts}</span>}
      </span>
    </Tooltip>
  );
}
