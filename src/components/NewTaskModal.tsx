import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, GitBranch } from 'lucide-react';
import { allAgentSpecs, type AgentKind } from '../lib/agents';
import { reportInvokeFailure } from '../lib/errorReporter';
import { knownRepoPaths, launchTask, repoPathForTerminal } from '../lib/tasks';
import { useAppStore } from '../store/appStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { AgentPicker } from './AgentPicker';
import { Modal } from './ui/Modal';

const INPUT = 'w-full bg-elevation-0 text-text-primary text-[13px] px-2.5 py-1.5 rounded-md ring-1 ring-border-light focus:ring-accent-primary outline-none';

/**
 * New Task: pick a repo, title, agent and base branch. The backend creates
 * `agentrium/<slug>` in a managed worktree and the agent starts there.
 */
export function NewTaskModal() {
  const close = useAppStore((s) => s.closeNewTaskModal);
  const presetRepo = useAppStore((s) => s.newTaskRepoPath);
  const { openAddAgent } = useAgentRegistryStore();
  const repoOptions = useMemo(() => knownRepoPaths(), []);
  const [repoPath, setRepoPath] = useState(
    () => presetRepo ?? repoPathForTerminal(useTerminalStore.getState().activeTerminalId) ?? repoOptions[0] ?? '',
  );
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentKind>(() => {
    const active = useTerminalStore.getState().terminals.get(useTerminalStore.getState().activeTerminalId ?? '');
    const kind = active?.config.agent;
    return kind && allAgentSpecs().some((s) => s.kind === kind) ? kind : 'claude';
  });
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchName, setBranchName] = useState('');
  const [titleAsPrompt, setTitleAsPrompt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const launching = useRef(false);

  // Branch suggestions only resolve for repos with an open session (the
  // backend trust check). Otherwise the field stays free text, and empty
  // means "the repo's current branch".
  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    if (!repoPath) return;
    invoke<string[]>('get_repo_branches', { path: repoPath })
      .then((b) => { if (!cancelled) setBranches(b.filter((x) => !x.startsWith('agentrium/'))); })
      .catch(() => { /* untrusted or not a repo: suggestions are optional */ });
    return () => { cancelled = true; };
  }, [repoPath]);

  const browse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: repoPath || undefined });
      if (selected && typeof selected === 'string') setRepoPath(selected);
    } catch (err) {
      reportInvokeFailure('dialog_open_directory', err);
    }
  };

  const submit = async () => {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError('');
    try {
      await launchTask({ repoPath, title, agent, baseBranch, branchName, titleAsPrompt });
      const app = useAppStore.getState();
      app.setSplitMode(false);
      if (app.gridMode) app.toggleGridMode();
      close();
      toast.success('Task started', `Working on ${title.trim()} in its own worktree.`);
    } catch (err) {
      // Validation and git refusals arrive as plain messages (user_err); the
      // inline error is the feedback. Internal failures are already reported
      // by the backend's wrap_cmd / createTerminal.
      setError(String(err));
    } finally {
      launching.current = false;
      setBusy(false);
    }
  };

  const canSubmit = !busy && repoPath.trim() !== '' && title.trim() !== '';

  return (
    <Modal title="New Task" showHeader onClose={() => { if (!busy) close(); }} panelClassName="w-full max-w-lg">
      <form
        className="p-4 flex flex-col gap-3.5"
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(); }}
      >
        <p className="text-[12px] text-text-secondary">
          The agent works on a new branch in its own git worktree, so parallel tasks never touch each other's files.
        </p>
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          Task title
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fix the login redirect loop"
            className={INPUT}
            disabled={busy}
          />
        </label>
        <div className="flex flex-col gap-1 text-[12px] text-text-secondary">
          <span>Repository</span>
          <div className="flex gap-2">
            <input
              aria-label="Repository"
              list="new-task-repos"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="Path to a git repository"
              className={`${INPUT} font-mono text-[12px]`}
              disabled={busy}
            />
            <datalist id="new-task-repos">
              {repoOptions.map((r) => <option key={r} value={r} />)}
            </datalist>
            <button type="button" onClick={browse} disabled={busy} aria-label="Browse for repository"
              className="px-2 rounded-md ring-1 ring-border-light text-text-secondary hover:bg-fill-hover">
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
        <fieldset disabled={busy} className="flex flex-col gap-1 text-[12px] text-text-secondary">
          <legend className="mb-1">Agent</legend>
          <AgentPicker value={agent} onChange={setAgent} onAddAgent={() => openAddAgent()} />
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Base branch
            <input
              list="new-task-branches"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="Current branch"
              className={INPUT}
              disabled={busy}
            />
            <datalist id="new-task-branches">
              {branches.map((b) => <option key={b} value={b} />)}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Branch name (optional)
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="agentrium/<title>"
              className={INPUT}
              disabled={busy}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-text-primary">
          <input type="checkbox" checked={titleAsPrompt} onChange={(e) => setTitleAsPrompt(e.target.checked)} disabled={busy} />
          Put the title in the prompt editor as the first prompt
        </label>
        {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" disabled={busy} onClick={close} className="px-3 py-1.5 text-[13px] text-text-secondary">Cancel</button>
          <button type="submit" disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg bg-accent-primary text-white text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5">
            <GitBranch size={13} />
            {busy ? 'Creating worktree...' : 'Start task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
