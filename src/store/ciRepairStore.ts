import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// CI repair tasks started from a failing pull request. Keyed by the repair
// task's worktree path, not by terminal id: a restored session gets a new id
// but keeps its worktree. The PR chip looks up repairs by `prKey`. Local UI
// state only; the task itself lives in the `tasks` table like any other.

const MAX_REPAIRS = 50;

export interface CiRepair {
  /** `prKey(root, branch)` of the pull request being repaired. */
  prKey: string;
  prNumber: number;
  prUrl: string;
  /** PR head branch the repair task branched from (its base branch). */
  branch: string;
  worktreePath: string;
  startedAt: number;
}

export function worktreeKey(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:\//i.test(p)) p = p.toLowerCase();
  return p;
}

interface CiRepairStore {
  repairs: Record<string, CiRepair>;
  addRepair: (repair: Omit<CiRepair, 'startedAt'>) => void;
  removeRepair: (worktreePath: string) => void;
}

export const useCiRepairStore = create<CiRepairStore>()(
  persist(
    (set) => ({
      repairs: {},
      addRepair: (repair) => set((s) => {
        const entries = Object.entries({ ...s.repairs, [worktreeKey(repair.worktreePath)]: { ...repair, startedAt: Date.now() } });
        const kept = entries.sort((a, b) => b[1].startedAt - a[1].startedAt).slice(0, MAX_REPAIRS);
        return { repairs: Object.fromEntries(kept) };
      }),
      removeRepair: (worktreePath) => set((s) => {
        const key = worktreeKey(worktreePath);
        if (!(key in s.repairs)) return {};
        const repairs = { ...s.repairs };
        delete repairs[key];
        return { repairs };
      }),
    }),
    { name: 'agentrium-ci-repairs', version: 1 },
  ),
);

/** The repair a task worktree was started for, if any. */
export function repairForWorktree(repairs: Record<string, CiRepair>, worktreePath: string | null | undefined): CiRepair | null {
  return worktreePath ? repairs[worktreeKey(worktreePath)] ?? null : null;
}
