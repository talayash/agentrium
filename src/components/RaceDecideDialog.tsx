import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitMerge, GitPullRequestCreate, Trophy, XCircle } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRaceStore, statsSnapshot, terminalForContender } from '../store/raceStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import {
  buildSquashMessage, commitTaskChanges, defaultMergeMode, finishTask, getTaskStatus, mergeBlockReason,
  type MergeMode, type TaskStatus,
} from '../lib/tasks';
import {
  abandonRace, checkVerdict, decideRace, loserLoss, pathKey, planDecision, racedAgainstTable, samePath,
  type ContenderFinish, type LoserPlan, type Race, type RaceContender, type WinnerAction,
} from '../lib/races';
import { BrandIcon } from './BrandIcon';
import { Modal } from './ui/Modal';

type Status = TaskStatus | 'missing';
interface LoserChoiceState { keepBranch: boolean; confirmed: boolean }

const letter = (i: number) => String.fromCharCode(65 + i);

/** Every open terminal working in a worktree (a handoff can leave several). */
function terminalsIn(worktree: string): string[] {
  return Array.from(useTerminalStore.getState().terminals.values())
    .filter((t) => (t.config.task && samePath(t.config.task.worktreePath, worktree)) || samePath(t.config.working_directory, worktree))
    .map((t) => t.config.id);
}

function liveTerminalsIn(worktree: string): string[] {
  const { terminals } = useTerminalStore.getState();
  return terminalsIn(worktree).filter((id) => {
    const s = terminals.get(id)?.config.status;
    return s === 'Running' || s === 'Idle';
  });
}

async function closeTerminals(ids: string[]) {
  for (const id of ids) {
    await useTerminalStore.getState().closeTerminal(id);
  }
}

/** Default winner: a contender whose check passed, else the first with work. */
function suggestedWinner(race: Race, statuses: Record<string, Status>): string {
  const checks = useRaceStore.getState().checks;
  const withWork = race.contenders.filter((c) => {
    const s = statuses[pathKey(c.worktreePath)];
    return s && s !== 'missing' && (s.ahead > 0 || s.uncommitted.length > 0);
  });
  const passed = withWork.find((c) => checkVerdict(checks[pathKey(c.worktreePath)]?.result) === 'pass');
  return (passed ?? withWork[0] ?? race.contenders[0]).worktreePath;
}

function summarizeFailures(results: ContenderFinish[], race: Race): string[] {
  return results.filter((r) => r.error).map((r) => {
    const c = race.contenders.find((x) => samePath(x.worktreePath, r.worktree_path));
    return `${c?.label ?? r.worktree_path}: ${r.error}`;
  });
}

/**
 * Pick winner / Abandon race. Lists exactly what will happen before it runs:
 * the winner merges through the normal task finish path (or stays for a
 * pull request), losers are discarded or keep their branch, and every
 * discarded contender's session closes, after confirmation if still running.
 */
export function RaceDecideDialog() {
  const raceId = useAppStore((s) => s.decideRaceId);
  const mode = useAppStore((s) => s.decideRaceMode);
  const close = useAppStore((s) => s.closeDecideRace);
  const strategy = useAppStore((s) => s.vcsDefaultMergeStrategy);
  const race = useRaceStore((s) => (raceId ? s.races[raceId] : undefined));
  const [statuses, setStatuses] = useState<Record<string, Status> | null>(null);
  const [winner, setWinner] = useState<string>('');
  const [action, setAction] = useState<'merge' | 'pr'>('merge');
  const [mergeMode, setMergeMode] = useState<MergeMode>('squash');
  const [message, setMessage] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [losers, setLosers] = useState<Record<string, LoserChoiceState>>({});
  const [closeRunningOk, setCloseRunningOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abandon = mode === 'abandon';

  const load = useCallback(async (seed: boolean) => {
    if (!race) return;
    const entries = await Promise.all(race.contenders.map(async (c): Promise<[string, Status]> => {
      try {
        return [pathKey(c.worktreePath), await getTaskStatus(c.worktreePath)];
      } catch {
        // Not registered any more (finished by hand): nothing to clean up.
        return [pathKey(c.worktreePath), 'missing'];
      }
    }));
    const next = Object.fromEntries(entries);
    setStatuses(next);
    if (seed) {
      const w = suggestedWinner(race, next);
      setWinner(w);
      const ws = next[pathKey(w)];
      if (ws && ws !== 'missing') {
        setMergeMode(defaultMergeMode(strategy, ws.behind));
        setMessage(buildSquashMessage(race.title, ws.changed_files));
      } else {
        setMessage(race.title);
      }
      setLosers(Object.fromEntries(race.contenders.map((c) => [pathKey(c.worktreePath), { keepBranch: false, confirmed: false }])));
    }
  }, [race, strategy]);

  useEffect(() => { void load(true); }, [load]);

  const winnerContender = race?.contenders.find((c) => samePath(c.worktreePath, winner));
  const winnerStatus = winner && statuses ? statuses[pathKey(winner)] : undefined;
  const loserContenders = useMemo(
    () => (race ? race.contenders.filter((c) => abandon || !samePath(c.worktreePath, winner)) : []),
    [race, winner, abandon],
  );

  const loserPlans: LoserPlan[] = loserContenders.map((c) => {
    const s = statuses?.[pathKey(c.worktreePath)];
    const choice = losers[pathKey(c.worktreePath)] ?? { keepBranch: false, confirmed: false };
    return {
      worktreePath: c.worktreePath, label: c.label, branch: c.branch, keepBranch: choice.keepBranch,
      ahead: s && s !== 'missing' ? s.ahead : 0,
      uncommitted: s && s !== 'missing' ? s.uncommitted.length : 0,
      confirmed: choice.confirmed,
    };
  });
  const runningLosers = loserContenders.filter((c) => liveTerminalsIn(c.worktreePath).length > 0);

  const winnerBlock = useMemo(() => {
    if (abandon || !winnerStatus) return null;
    if (winnerStatus === 'missing') return 'The winner\'s worktree is no longer a task managed by Agentrium.';
    if (winnerStatus.uncommitted.length > 0) return 'The winner has uncommitted changes. Commit them first.';
    if (action === 'pr') return winnerStatus.ahead === 0 ? 'The winner has no commits for a pull request.' : null;
    return mergeBlockReason(winnerStatus, mergeMode);
  }, [abandon, winnerStatus, action, mergeMode]);

  if (!raceId || !race) return null;

  const unconfirmed = loserPlans.filter((l) => !l.keepBranch && loserLoss(l) && !l.confirmed);
  const canConfirm = !busy && !!statuses && !winnerBlock && unconfirmed.length === 0
    && (runningLosers.length === 0 || closeRunningOk) && (abandon || !!winner);

  const setLoser = (c: RaceContender, patch: Partial<LoserChoiceState>) => setLosers((m) => ({
    ...m, [pathKey(c.worktreePath)]: { ...(m[pathKey(c.worktreePath)] ?? { keepBranch: false, confirmed: false }), ...patch },
  }));

  const commitWinner = async () => {
    if (!winnerContender) return;
    setBusy(true);
    setError('');
    try {
      await commitTaskChanges(winnerContender.worktreePath, commitMessage || `${race.title} (${winnerContender.label})`);
      await load(false);
    } catch (err) {
      // Git refusals are plain messages; the backend reports real failures.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const dismissRaceItem = () => {
    const attention = useAttentionStore.getState();
    for (const item of attention.items) {
      if (item.raceId === race.id) attention.dismiss(item.terminalId, 'race');
    }
  };

  /** Fresh diff stats for the history snapshot (the compare view may never
   *  have been opened). */
  const snapshot = async () => {
    await useRaceStore.getState().loadDiffs(race.id);
    return statsSnapshot(race);
  };

  const confirmAbandon = async () => {
    const stats = await snapshot();
    const plan = planDecision(race.id, '', { kind: 'pull-request' }, loserPlans, stats);
    if (!plan.ok) return;
    setBusy(true);
    setError('');
    try {
      // A live agent holds its folder open on Windows: close sessions first.
      for (const c of race.contenders) await closeTerminals(terminalsIn(c.worktreePath));
      const results = await abandonRace(race.id, plan.request.losers, stats);
      const failures = summarizeFailures(results, race);
      if (failures.length) toast.warning('Some contenders were left in place', failures.join('\n'));
      else toast.success('Race abandoned', `All ${race.contenders.length} contenders were discarded.`);
      dismissRaceItem();
      await useRaceStore.getState().refresh(race.id);
      close();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDecide = async () => {
    if (!winnerContender) return;
    const stats = await snapshot();
    const winnerAction: WinnerAction = action === 'merge'
      ? { kind: 'merge', mode: mergeMode, message }
      : { kind: 'pull-request' };
    const plan = planDecision(race.id, winnerContender.worktreePath, winnerAction, loserPlans, stats);
    if (!plan.ok) return;
    setBusy(true);
    setError('');
    try {
      // Losers' sessions close first (a live agent blocks worktree removal
      // on Windows). The winner stays open until its merge succeeds, so a
      // refused merge costs nothing.
      for (const c of loserContenders) await closeTerminals(terminalsIn(c.worktreePath));
      const result = await decideRace(plan.request);
      const failures = summarizeFailures(result.losers, race);
      if (action === 'merge') {
        await closeTerminals(terminalsIn(winnerContender.worktreePath));
        if (result.winner && !result.winner.worktree_removed) {
          // Same follow-up as FinishTaskDialog: the merge is in; remove the
          // now-closed worktree and its (squashed, so "unmerged") branch.
          await finishTask(winnerContender.worktreePath, { kind: 'discard', confirm_unmerged: true })
            .catch((err) => {
              toast.warning('Merged, but the worktree was kept', String(err));
              reportInvokeFailure('finish_task', err);
            });
        }
        toast.success('Winner merged', `${winnerContender.label} (${winnerContender.branch}) was merged into ${race.baseBranch}.`);
      } else {
        const terminalId = terminalForContender(winnerContender, useTerminalStore.getState().terminals)?.config.id ?? null;
        useAppStore.getState().openCreatePrModal(
          winnerContender.worktreePath, terminalId, racedAgainstTable(race, winnerContender.worktreePath, stats),
        );
      }
      if (failures.length) toast.warning('Some contenders were left in place', failures.join('\n'));
      dismissRaceItem();
      await useRaceStore.getState().refresh(race.id);
      close();
    } catch (err) {
      // Git refusals (dirty base, conflicts) come back as plain messages and
      // nothing was discarded; internal failures were reported by wrap_cmd.
      setError(String(err));
      void load(false);
    } finally {
      setBusy(false);
    }
  };

  const steps: string[] = [];
  if (!abandon && winnerContender) {
    steps.push(action === 'merge'
      ? `${mergeMode === 'squash' ? 'Squash-merge' : 'Fast-forward'} ${winnerContender.branch} into ${race.baseBranch}, then remove its worktree and branch and close its session.`
      : `Keep ${winnerContender.branch} and its worktree, and open Create Pull Request with a "Raced against" summary.`);
  }
  for (const l of loserPlans) {
    steps.push(l.keepBranch
      ? `${l.label}: remove the worktree, keep ${l.branch}.`
      : `${l.label}: delete the worktree and ${l.branch}${loserLoss(l) ? ` (loses ${loserLoss(l)})` : ''}.`);
  }
  if (runningLosers.length) steps.push(`Close ${runningLosers.length} running session(s).`);

  return (
    <Modal title={abandon ? 'Abandon race' : 'Pick winner'} showHeader onClose={() => { if (!busy) close(); }}
      panelClassName="w-full max-w-xl max-h-[90vh] overflow-y-auto">
      <div className="p-4 flex flex-col gap-4 text-[13px]">
        {!statuses && <p role="status" className="text-text-secondary text-[12px]">Checking every worktree...</p>}

        {statuses && !abandon && (
          <fieldset disabled={busy} className="flex flex-col gap-1.5">
            <legend className="text-[12px] text-text-secondary mb-1">Winner</legend>
            {race.contenders.map((c, i) => {
              const s = statuses[pathKey(c.worktreePath)];
              return (
                <label key={c.idx} className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer ${samePath(winner, c.worktreePath) ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30' : 'hover:bg-fill-hover'}`}>
                  <input type="radio" name="race-winner" checked={samePath(winner, c.worktreePath)} onChange={() => {
                    setWinner(c.worktreePath);
                    if (s && s !== 'missing') {
                      setMergeMode(defaultMergeMode(strategy, s.behind));
                      setMessage(buildSquashMessage(race.title, s.changed_files));
                    }
                  }} />
                  <span className="text-text-tertiary w-3">{letter(i)}</span>
                  <BrandIcon kind={c.agent} size={13} />
                  <span className="text-text-primary">{c.label}</span>
                  <span className="ml-auto text-[11.5px] text-text-secondary tabular-nums">
                    {s === 'missing' ? 'worktree gone' : s ? `${s.ahead} ahead${s.uncommitted.length ? `, ${s.uncommitted.length} uncommitted` : ''}` : ''}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {statuses && !abandon && winnerContender && (
          <fieldset disabled={busy} className="flex flex-col gap-2">
            <legend className="text-[12px] text-text-secondary mb-1">Then</legend>
            <label className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer ${action === 'merge' ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30' : 'hover:bg-fill-hover'}`}>
              <input type="radio" name="race-action" className="mt-1" checked={action === 'merge'} onChange={() => setAction('merge')} />
              <GitMerge size={14} className="mt-0.5 text-text-tertiary" />
              <span className="flex flex-col">
                <span className="text-text-primary">Merge into {race.baseBranch}</span>
                <span className="text-[11.5px] text-text-secondary">Through the normal task finish: the worktree and branch are removed after the merge.</span>
              </span>
            </label>
            {action === 'merge' && (
              <div className="ml-7 flex flex-col gap-2">
                <div className="flex gap-1" role="radiogroup" aria-label="Merge mode">
                  {(['squash', 'fast-forward'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mergeMode === m} onClick={() => setMergeMode(m)}
                      className={`px-2.5 py-1 rounded-md text-[12px] ${mergeMode === m ? 'bg-accent-primary text-white' : 'bg-fill-hover text-text-secondary'}`}>
                      {m === 'squash' ? 'Squash' : 'Fast-forward'}
                    </button>
                  ))}
                </div>
                {mergeMode === 'squash' && (
                  <textarea aria-label="Squash commit message" value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
                    className="w-full p-2 rounded-md bg-elevation-0 ring-1 ring-border-light text-text-primary font-mono text-[12px] resize-y" />
                )}
              </div>
            )}
            <label className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer ${action === 'pr' ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30' : 'hover:bg-fill-hover'}`}>
              <input type="radio" name="race-action" className="mt-1" checked={action === 'pr'} onChange={() => setAction('pr')} />
              <GitPullRequestCreate size={14} className="mt-0.5 text-text-tertiary" />
              <span className="flex flex-col">
                <span className="text-text-primary">Keep the branch and create a pull request</span>
                <span className="text-[11.5px] text-text-secondary">The PR body gets a "Raced against" table. Finish the task later as usual.</span>
              </span>
            </label>
            {winnerStatus && winnerStatus !== 'missing' && winnerStatus.uncommitted.length > 0 && (
              <div className="rounded-lg ring-1 ring-warning/40 bg-warning/5 p-2.5 flex gap-2">
                <input aria-label="Commit message for the winner" value={commitMessage} placeholder={`${race.title} (${winnerContender.label})`}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="flex-1 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light" />
                <button type="button" onClick={commitWinner} className="px-3 py-1 rounded bg-accent-primary text-white text-[12px] disabled:opacity-50">
                  Commit first
                </button>
              </div>
            )}
          </fieldset>
        )}

        {statuses && loserContenders.length > 0 && (
          <fieldset disabled={busy} className="flex flex-col gap-1.5">
            <legend className="text-[12px] text-text-secondary mb-1">{abandon ? 'Every contender' : 'The others'}</legend>
            {loserContenders.map((c) => {
              const plan = loserPlans.find((l) => samePath(l.worktreePath, c.worktreePath))!;
              const loss = loserLoss(plan);
              return (
                <div key={c.idx} className="p-2 rounded-lg ring-1 ring-inset ring-seam flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <BrandIcon kind={c.agent} size={13} />
                    <span className="text-text-primary">{c.label}</span>
                    <span className="font-mono text-[11px] text-text-tertiary truncate">{c.branch}</span>
                    <label className="ml-auto flex items-center gap-1.5 text-[12px] text-text-secondary whitespace-nowrap">
                      <input type="checkbox" checked={plan.keepBranch} onChange={(e) => setLoser(c, { keepBranch: e.target.checked })} />
                      Keep branch
                    </label>
                  </div>
                  {!plan.keepBranch && loss && (
                    <label className="flex items-center gap-1.5 text-[12px] text-error">
                      <input type="checkbox" checked={plan.confirmed} onChange={(e) => setLoser(c, { confirmed: e.target.checked })} />
                      Discard {loss}
                    </label>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        {runningLosers.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-text-primary">
            <input type="checkbox" checked={closeRunningOk} onChange={(e) => setCloseRunningOk(e.target.checked)} disabled={busy} />
            Close {runningLosers.length} session(s) that are still running ({runningLosers.map((c) => c.label).join(', ')})
          </label>
        )}

        {statuses && steps.length > 0 && (
          <section className="rounded-lg bg-elevation-1 ring-1 ring-inset ring-seam p-2.5">
            <p className="text-[12px] text-text-secondary mb-1">What happens</p>
            <ol className="list-decimal ml-4 text-[12px] text-text-primary flex flex-col gap-0.5">
              {steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
          </section>
        )}

        {winnerBlock && <p className="text-[12px] text-warning">{winnerBlock}</p>}
        {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button disabled={busy} onClick={close} className="px-3 py-1.5 text-text-secondary">Cancel</button>
          <button disabled={!canConfirm} onClick={() => void (abandon ? confirmAbandon() : confirmDecide())}
            className={`px-4 py-1.5 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5 ${abandon ? 'bg-error' : 'bg-accent-primary'}`}>
            {abandon ? <XCircle size={13} /> : <Trophy size={13} />}
            {busy ? 'Working...' : abandon ? 'Abandon race' : action === 'merge' ? 'Merge winner' : 'Keep winner and create PR'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
