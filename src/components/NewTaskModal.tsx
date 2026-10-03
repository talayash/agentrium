import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Flag, FolderOpen, GitBranch } from 'lucide-react';
import { allAgentSpecs, type AgentKind } from '../lib/agents';
import { reportInvokeFailure } from '../lib/errorReporter';
import { knownRepoPaths, launchTask, repoPathForTerminal, type TaskProfile } from '../lib/tasks';
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
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branchName, setBranchName] = useState('');
  const [titleAsPrompt, setTitleAsPrompt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const launching = useRef(false);
  // Source of the repo (and launch config): a saved profile, or a folder.
  const [source, setSource] = useState<'profile' | 'folder'>(presetRepo ? 'folder' : 'profile');
  const [profiles, setProfiles] = useState<TaskProfile[] | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const profile = profiles?.find((p) => p.id === profileId) ?? null;

  useEffect(() => {
    let cancelled = false;
    invoke<TaskProfile[]>('get_profiles')
      .then((list) => {
        if (cancelled) return;
        const usable = list.filter((p) => p.working_directory.trim() !== '');
        setProfiles(usable);
        if (usable.length === 0) { setSource('folder'); return; }
        // Prefer the profile for the active session's repo, then the default.
        const key = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const pick = usable.find((p) => repoPath && key(p.working_directory) === key(repoPath))
          ?? usable.find((p) => p.is_default) ?? usable[0];
        setProfileId(pick.id);
      })
      .catch((err) => {
        if (cancelled) return;
        setProfiles([]);
        setSource('folder');
        reportInvokeFailure('get_profiles', err);
      });
    return () => { cancelled = true; };
    // Load once per open; repoPath is only the initial preference.
  }, []);

  // Choosing a profile points the task at its folder and its agent.
  useEffect(() => {
    if (source !== 'profile' || !profile) return;
    setRepoPath(profile.working_directory);
    if (allAgentSpecs().some((s) => s.kind === profile.agent)) setAgent(profile.agent);
  }, [source, profile]);

  // Uses start_task's trust rule, so any repo the modal can launch in lists
  // its branches. Empty baseBranch means "the repo's current branch".
  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    setCurrentBranch(null);
    setBaseBranch('');
    if (!repoPath) return;
    const handle = setTimeout(() => {
      invoke<{ current: string | null; branches: string[] }>('list_task_base_branches', { repoPath })
        .then((b) => { if (!cancelled) { setBranches(b.branches); setCurrentBranch(b.current); } })
        // Untrusted or not a repo yet (e.g. mid-typing a path): start_task
        // reports the real reason on submit, and "Current branch" still works.
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
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
      await launchTask({
        repoPath, title, agent, baseBranch, branchName, titleAsPrompt,
        profile: source === 'profile' ? profile : null,
      });
      const app = useAppStore.getState();
      app.setSplitMode(false);
      if (app.gridMode) app.toggleGridMode();
      close();
      toast.success('Task started', titleAsPrompt
        ? `${title.trim()} is in its own worktree. The title is staged: press Ctrl+Shift+E when the agent is ready.`
        : `${title.trim()} is in its own worktree.`);
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

  const canSubmit = !busy && repoPath.trim() !== '' && title.trim() !== '' && (source === 'folder' || !!profile);

  // Race toggle: hand the repo and title over to the New Race modal.
  const switchToRace = () => {
    const app = useAppStore.getState();
    close();
    app.openNewRaceModal(repoPath || null, title.trim() || null);
  };

  return (
    <Modal title="New Task" showHeader onClose={() => { if (!busy) close(); }} panelClassName="w-full max-w-lg">
      <form
        className="p-4 flex flex-col gap-3.5"
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(); }}
      >
        <div className="flex items-start gap-3">
          <p className="text-[12px] text-text-secondary flex-1">
            The agent works on a new branch in its own git worktree, so parallel tasks never touch each other's files.
          </p>
          <button type="button" role="switch" aria-checked={false} onClick={switchToRace} disabled={busy}
            title="Race: send this task to 2-4 agents or models and keep the best result"
            className="flex items-center gap-1.5 px-2 h-[24px] rounded-md ring-1 ring-inset ring-seam text-[11.5px] text-text-secondary hover:text-text-primary hover:bg-fill-hover flex-shrink-0">
            <Flag size={12} /> Race
          </button>
        </div>
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
          <div className="flex items-center justify-between">
            <span>Start from</span>
            <div className="flex gap-0.5" role="radiogroup" aria-label="Start from">
              {(['profile', 'folder'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={source === s} disabled={busy || (s === 'profile' && !profiles?.length)}
                  onClick={() => setSource(s)}
                  className={`px-2 h-[22px] rounded-md text-[11.5px] disabled:opacity-40 ${source === s ? 'bg-fill-active text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}>
                  {s === 'profile' ? 'Profile' : 'Folder'}
                </button>
              ))}
            </div>
          </div>
          {source === 'profile' ? (
            <>
              <select aria-label="Profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={busy || profiles === null}
                className={INPUT}>
                {profiles === null && <option value="">Loading profiles...</option>}
                {profiles?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {profile && (
                <span className="font-mono text-[11px] text-text-tertiary truncate" title={profile.working_directory}>
                  {profile.working_directory}
                </span>
              )}
            </>
          ) : (
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
          )}
        </div>
        <fieldset disabled={busy} className="flex flex-col gap-1 text-[12px] text-text-secondary">
          <legend className="mb-1">Agent</legend>
          <AgentPicker value={agent} onChange={setAgent} onAddAgent={() => openAddAgent()} />
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Base branch
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className={`${INPUT} font-mono text-[12px]`}
              disabled={busy}
            >
              <option value="">{currentBranch ? `Current branch (${currentBranch})` : 'Current branch'}</option>
              {branches.filter((b) => b !== currentBranch).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
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
          Stage the title as the first prompt (review and send with Ctrl+Shift+E)
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
