import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitMerge, Archive, Trash2 } from 'lucide-react';
import { reportInvokeFailure } from '../lib/errorReporter';
import {
  buildSquashMessage, commitTaskChanges, defaultMergeMode, finishActionFor, finishTask, getTaskStatus,
  mergeBlockReason, type FinishChoice, type MergeMode, type TaskInfo, type TaskStatus,
} from '../lib/tasks';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { Modal } from './ui/Modal';

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Every open terminal working in the task's worktree (a same-worktree
 *  handoff leaves more than one). */
function terminalsInWorktree(task: TaskInfo): string[] {
  return Array.from(useTerminalStore.getState().terminals.values())
    .filter((t) => (t.config.task && samePath(t.config.task.worktreePath, task.worktreePath))
      || samePath(t.config.working_directory, task.worktreePath))
    .map((t) => t.config.id);
}

async function closeTerminals(ids: string[]) {
  for (const id of ids) {
    await useTerminalStore.getState().closeTerminal(id);
  }
}

/**
 * Finish a task: merge back (fast-forward or squash), keep the branch, or
 * discard everything. Opened from the session menu or when a task session is
 * closed. The worktree's terminals are closed as part of finishing, because a
 * live process inside the folder blocks its removal on Windows.
 */
export function FinishTaskDialog() {
  const terminalId = useAppStore((s) => s.finishTaskTerminalId);
  const closeAfter = useAppStore((s) => s.finishTaskCloseAfter);
  const closeDialog = useAppStore((s) => s.closeFinishTask);
  const strategy = useAppStore((s) => s.vcsDefaultMergeStrategy);
  // Snapshot: the terminal may close while the dialog is still open.
  const [task] = useState<TaskInfo | null>(
    () => (terminalId ? useTerminalStore.getState().terminals.get(terminalId)?.config.task ?? null : null),
  );
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState<FinishChoice>('merge');
  const [mode, setMode] = useState<MergeMode>('squash');
  const [message, setMessage] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [confirmedDiscard, setConfirmedDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seeded = useRef(false);

  const load = useCallback(async () => {
    if (!task) return;
    try {
      const s = await getTaskStatus(task.worktreePath);
      setStatus(s);
      setLoadError('');
      if (!seeded.current) {
        seeded.current = true;
        setMode(defaultMergeMode(strategy, s.behind));
        setMessage(buildSquashMessage(task.title, s.changed_files));
        setCommitMessage(task.title);
        if (s.ahead === 0 && s.uncommitted.length === 0) setChoice('discard');
      } else {
        setMessage((m) => (m.trim() === '' ? buildSquashMessage(task.title, s.changed_files) : m));
      }
    } catch (err) {
      setLoadError(String(err));
    }
  }, [task, strategy]);

  useEffect(() => { void load(); }, [load]);

  const blockReason = useMemo(() => {
    if (!status) return null;
    if (choice !== 'discard' && status.uncommitted.length > 0) {
      return 'Commit the uncommitted changes first. Removing the worktree would lose them.';
    }
    if (choice === 'merge') return mergeBlockReason(status, mode);
    return null;
  }, [status, choice, mode]);

  if (!terminalId || !task) return null;

  const closeSessionOnly = async () => {
    setBusy(true);
    try {
      await useTerminalStore.getState().closeTerminal(terminalId);
      closeDialog();
    } catch (err) {
      toast.error('Close failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      await commitTaskChanges(task.worktreePath, commitMessage);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!status) return;
    const action = finishActionFor(choice, { mode, message, ahead: status.ahead, confirmedDiscard });
    if (action === 'needs-confirmation') {
      setConfirmedDiscard(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const ids = terminalsInWorktree(task);
      if (action.kind === 'merge') {
        // Merge while the session is still open, so a refused merge costs
        // nothing. Cleanup can then fail on Windows because the agent's
        // process holds the folder; finish it after closing the sessions.
        const result = await finishTask(task.worktreePath, action);
        await closeTerminals(ids);
        if (!result.worktree_removed) {
          await finishTask(task.worktreePath, { kind: 'discard', confirm_unmerged: true });
        }
        toast.success('Task merged', `${task.branch} was merged into ${task.baseBranch}.`);
      } else {
        await closeTerminals(ids);
        await finishTask(task.worktreePath, action);
        toast.success(
          action.kind === 'keep' ? 'Worktree removed' : 'Task discarded',
          action.kind === 'keep' ? `Branch ${task.branch} was kept.` : `${task.branch} was deleted.`,
        );
      }
      closeDialog();
    } catch (err) {
      // Git refusals (conflicts, dirty trees) come back as plain messages.
      setError(String(err));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel =
    choice === 'merge' ? (mode === 'squash' ? 'Squash and finish' : 'Fast-forward and finish')
      : choice === 'keep' ? 'Remove worktree'
        : confirmedDiscard ? `Discard ${status?.ahead ?? 0} commit(s)` : 'Discard task';

  return (
    <Modal title="Finish task" showHeader onClose={() => { if (!busy) closeDialog(); }} panelClassName="w-full max-w-xl max-h-[90vh] overflow-y-auto">
      <div className="p-4 flex flex-col gap-4 text-[13px]">
        <div className="flex items-center gap-2 text-text-secondary">
          <GitBranch size={14} className="text-purple-400" />
          <span className="font-mono text-text-primary">{task.branch}</span>
          <span>into</span>
          <span className="font-mono text-text-primary">{task.baseBranch}</span>
          {status && (
            <span className="ml-auto text-[12px] tabular-nums">
              {status.ahead} ahead, {status.behind} behind
            </span>
          )}
        </div>

        {loadError && <p role="alert" className="text-error text-[12px]">{loadError}</p>}
        {!status && !loadError && <p role="status" className="text-text-secondary text-[12px]">Checking the worktree...</p>}

        {status && status.uncommitted.length > 0 && (
          <section className="rounded-lg ring-1 ring-warning/40 bg-warning/5 p-3 flex flex-col gap-2">
            <p className="text-text-primary font-medium">{status.uncommitted.length} uncommitted change(s) in the task worktree</p>
            <ul className="max-h-28 overflow-y-auto font-mono text-[11.5px] text-text-secondary">
              {status.uncommitted.slice(0, 100).map((f) => <li key={f.path}>{f.status.padEnd(2)} {f.path}</li>)}
            </ul>
            <div className="flex gap-2">
              <input aria-label="Commit message" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} disabled={busy}
                className="flex-1 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light" />
              <button onClick={commit} disabled={busy || !commitMessage.trim()} className="px-3 py-1 rounded bg-accent-primary text-white text-[12px] disabled:opacity-50">
                Commit all
              </button>
            </div>
          </section>
        )}

        {status && (
          <fieldset disabled={busy} className="flex flex-col gap-2">
            <legend className="sr-only">How to finish</legend>
            <ChoiceRow value="merge" current={choice} onChange={setChoice} icon={<GitMerge size={14} />}
              title={`Merge back into ${task.baseBranch}`} hint="Then remove the worktree and the task branch." />
            {choice === 'merge' && (
              <div className="ml-7 flex flex-col gap-2">
                <div className="flex gap-1" role="radiogroup" aria-label="Merge mode">
                  {(['squash', 'fast-forward'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                      className={`px-2.5 py-1 rounded-md text-[12px] ${mode === m ? 'bg-accent-primary text-white' : 'bg-fill-hover text-text-secondary'}`}>
                      {m === 'squash' ? 'Squash' : 'Fast-forward'}
                    </button>
                  ))}
                </div>
                {mode === 'squash' && (
                  <textarea aria-label="Squash commit message" value={message} onChange={(e) => setMessage(e.target.value)} rows={5}
                    className="w-full p-2 rounded-md bg-elevation-0 ring-1 ring-border-light text-text-primary font-mono text-[12px] resize-y" />
                )}
              </div>
            )}
            <ChoiceRow value="keep" current={choice} onChange={setChoice} icon={<Archive size={14} />}
              title="Keep the branch, remove the worktree" hint={`${task.branch} stays for later.`} />
            <ChoiceRow value="discard" current={choice} onChange={(c) => { setChoice(c); setConfirmedDiscard(false); }} icon={<Trash2 size={14} />}
              title="Discard" hint="Remove the worktree and delete the branch." />
          </fieldset>
        )}

        {blockReason && <p className="text-[12px] text-warning">{blockReason}</p>}
        {choice === 'discard' && confirmedDiscard && status && status.ahead > 0 && (
          <p role="alert" className="text-[12px] text-error">
            {task.branch} has {status.ahead} commit(s) that are not in {task.baseBranch}. They will be lost. Click again to confirm.
          </p>
        )}
        {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          {closeAfter && (
            <button disabled={busy} onClick={closeSessionOnly} className="mr-auto px-3 py-1.5 text-text-secondary text-[12px]">
              Close session, keep worktree
            </button>
          )}
          <button disabled={busy} onClick={closeDialog} className="px-3 py-1.5 text-text-secondary">Cancel</button>
          <button disabled={busy || !status || !!blockReason} onClick={confirm}
            className={`px-4 py-1.5 rounded-lg text-white disabled:opacity-50 ${choice === 'discard' ? 'bg-error' : 'bg-accent-primary'}`}>
            {busy ? 'Working...' : primaryLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChoiceRow({ value, current, onChange, icon, title, hint }: {
  value: FinishChoice; current: FinishChoice; onChange: (c: FinishChoice) => void;
  icon: React.ReactNode; title: string; hint: string;
}) {
  return (
    <label className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer ${current === value ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30' : 'hover:bg-fill-hover'}`}>
      <input type="radio" name="finish-choice" className="mt-1" checked={current === value} onChange={() => onChange(value)} />
      <span className="mt-0.5 text-text-tertiary">{icon}</span>
      <span className="flex flex-col">
        <span className="text-text-primary">{title}</span>
        <span className="text-[11.5px] text-text-secondary">{hint}</span>
      </span>
    </label>
  );
}
