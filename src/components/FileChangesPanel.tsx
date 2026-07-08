import { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } from 'react';
import { RefreshCw, GitBranch, GitFork, FolderOpen, ChevronRight, ChevronDown, CircleDot, ArrowUp, ArrowDown, Upload, Archive, Package, Loader2, Trash2, Download, Plus, Check, Search as SearchIcon, Pin, PinOff, GitPullRequestArrow, TerminalSquare, MoreVertical } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { ChangelistSection, type MergedChange } from './ChangelistSection';
import type { WorktreeInfo, PushPreview } from '../types/git';

const DIRTY_TREE_PREFIX = 'Working tree has uncommitted changes';

// Invokes git_pull_branch; on a dirty-tree refusal, prompts the user to stash,
// pull, and pop. Throws the original error if the user cancels, or any other
// error untouched. Backend handles the stash/pop atomicity.
async function pullWithStashConfirm(args: {
  path: string;
  remote: string;
  branch: string;
  strategy: 'merge' | 'rebase' | 'ff-only';
}): Promise<string> {
  try {
    return await invoke<string>('git_pull_branch', { ...args, autoStash: false });
  } catch (err) {
    const msg = typeof err === 'string' ? err : '';
    if (!msg.startsWith(DIRTY_TREE_PREFIX)) throw err;
    const ok = window.confirm(
      `${msg}\n\nStash your changes, pull from ${args.remote}/${args.branch}, then re-apply the stash?`,
    );
    if (!ok) throw err;
    return await invoke<string>('git_pull_branch', { ...args, autoStash: true });
  }
}

interface FileChange {
  path: string;
  status: string;
  staged: boolean;
}

type AutoStageMode = 'none' | 'tracked' | 'all';

interface FileChangesResult {
  terminal_id: string;
  working_directory: string;
  /** Absolute repo top-level - porcelain paths in `changes` are relative to this. */
  repo_root: string | null;
  changes: FileChange[];
  is_git_repo: boolean;
  branch: string | null;
  error: string | null;
}

interface ScannedGitRepo {
  path: string;
  relative_path: string;
  branch: string | null;
  is_worktree: boolean;
  is_main_repo: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
}

interface StashEntry {
  reference: string;
  message: string;
  branch: string | null;
}

interface LastCommitInfo {
  subject: string;
  message: string;
}

interface RepoSelectionCtx {
  selectedRepoPath: string | null;
  activePath: string | null;
  setSelectedRepoPath: (p: string | null) => void;
}
const RepoSelectionContext = createContext<RepoSelectionCtx>({
  selectedRepoPath: null,
  activePath: null,
  setSelectedRepoPath: () => {},
});

export function FileChangesPanel() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const terminals = useTerminalStore((s) => s.terminals);
  const gitInfoCache = useTerminalStore((s) => s.gitInfoCache);
  const changesRefreshTrigger = useAppStore((s) => s.changesRefreshTrigger);
  const openWorktreeModal = useAppStore((s) => s.openWorktreeModal);
  const showGitPanel = useAppStore((s) => s.showGitPanel);
  const setPinnedRepoPath = useAppStore((s) => s.setPinnedRepoPath);
  const repositoriesHeightRatio = useAppStore((s) => s.repositoriesHeightRatio);
  const setRepositoriesHeightRatio = useAppStore((s) => s.setRepositoriesHeightRatio);
  const activeGitInfo = activeTerminalId ? gitInfoCache.get(activeTerminalId) : null;
  const activeCwd = useMemo(() => {
    if (!activeTerminalId) return null;
    return terminals.get(activeTerminalId)?.config.working_directory ?? null;
  }, [activeTerminalId, terminals]);
  const [result, setResult] = useState<FileChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [repos, setRepos] = useState<ScannedGitRepo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposExpanded, setReposExpanded] = useState(true);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(null);

  const activePath = selectedRepoPath ?? activeCwd;
  const usingSelectedRepo = selectedRepoPath !== null && !!activeCwd && !pathsEqual(selectedRepoPath, activeCwd);

  // Reset selection when the active terminal changes
  useEffect(() => { setSelectedRepoPath(null); }, [activeTerminalId]);

  // Publish the explicit repo pin so other panels (file tree) can follow it.
  // Only publish when the user has actually selected a nested repo - otherwise
  // other panels fall back to the active terminal's cwd.
  useEffect(() => {
    setPinnedRepoPath(selectedRepoPath);
    return () => setPinnedRepoPath(null);
  }, [selectedRepoPath, setPinnedRepoPath]);

  // Commit / push / stash state
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pullingTop, setPullingTop] = useState(false);
  const [stashing, setStashing] = useState(false);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [stashesExpanded, setStashesExpanded] = useState(false);
  const [stashActing, setStashActing] = useState<string | null>(null);
  const [amend, setAmend] = useState(false);
  const [lastCommit, setLastCommit] = useState<LastCommitInfo | null>(null);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  // Files currently being staged/unstaged - keyed by "stage:path" or "unstage:path"
  const [stagingPaths, setStagingPaths] = useState<Set<string>>(new Set());
  const triggerChangesRefreshAction = useAppStore.getState().triggerChangesRefresh;

  const fetchRepos = useCallback(async (cwd: string) => {
    setReposLoading(true);
    try {
      const rows = await invoke<ScannedGitRepo[]>('scan_git_repos', { rootPath: cwd });
      setRepos(rows);

      // Pick a repo path to query worktrees on. Prefer the main repo from
      // `get_worktree_info` (handles the case where cwd is itself a linked
      // worktree); fall back to the scanned root.
      const mainRow = rows.find((r) => r.is_main_repo);
      const wtRoot = activeGitInfo?.main_repo_path ?? mainRow?.path ?? null;
      if (wtRoot) {
        try {
          const wts = await invoke<WorktreeInfo[]>('list_worktrees', { path: wtRoot });
          setWorktrees(wts);
        } catch {
          setWorktrees([]);
        }
      } else {
        setWorktrees([]);
      }
    } catch {
      setRepos([]);
      setWorktrees([]);
    } finally {
      setReposLoading(false);
    }
  }, [activeGitInfo?.main_repo_path]);

  useEffect(() => {
    if (!showGitPanel) return;
    if (!activeCwd) { setRepos([]); setWorktrees([]); return; }
    fetchRepos(activeCwd);
  }, [activeCwd, showGitPanel, changesRefreshTrigger, fetchRepos]);

  const fetchStashes = useCallback(async (cwd: string) => {
    try {
      const rows = await invoke<StashEntry[]>('git_list_stashes', { path: cwd });
      setStashes(rows);
    } catch {
      setStashes([]);
    }
  }, []);

  useEffect(() => {
    if (!activePath || !result?.is_git_repo) { setStashes([]); return; }
    fetchStashes(activePath);
  }, [activePath, result?.is_git_repo, changesRefreshTrigger, fetchStashes]);

  // Last commit - feeds the IntelliJ-style "Amend" row.
  useEffect(() => {
    if (!activePath || !result?.is_git_repo) { setLastCommit(null); return; }
    let cancelled = false;
    invoke<LastCommitInfo | null>('get_last_commit_info', { path: activePath })
      .then((info) => { if (!cancelled) setLastCommit(info); })
      .catch(() => { if (!cancelled) setLastCommit(null); });
    return () => { cancelled = true; };
  }, [activePath, result?.is_git_repo, changesRefreshTrigger]);

  // Reset amend when switching repos so a stale checkbox can't rewrite the
  // wrong repo's history.
  useEffect(() => { setAmend(false); }, [activePath]);

  const toggleAmend = useCallback(() => {
    setAmend((prev) => {
      const next = !prev;
      // IntelliJ pre-fills the message with the commit being amended.
      if (next && !commitMessage.trim() && lastCommit) {
        setCommitMessage(lastCommit.message);
      }
      return next;
    });
  }, [commitMessage, lastCommit]);

  const handleCommit = useCallback(async (thenPush: boolean, autoStage: AutoStageMode) => {
    if (!activePath) return;
    const msg = commitMessage.trim();
    if (!msg) {
      toast.error('Commit', 'Enter a commit message');
      return;
    }
    setCommitting(true);
    try {
      await invoke('git_commit', { path: activePath, message: msg, autoStage, amend });
      toast.success(amend ? 'Amended' : 'Committed', thenPush ? 'Pushing…' : msg.split('\n')[0]);
      setCommitMessage('');
      setAmend(false);
      if (thenPush) {
        setPushing(true);
        try {
          const preview = await invoke<PushPreview>('get_push_preview', { path: activePath });
          await invoke('git_push', {
            path: activePath,
            remote: preview.default_remote,
            remoteBranch: preview.default_remote_branch,
            mode: 'normal',
            pushTags: false,
            setUpstream: !preview.has_upstream,
          });
          toast.success('Pushed', `Pushed to ${preview.default_remote}/${preview.default_remote_branch}`);
        } catch (err) {
          toast.error('Push failed', typeof err === 'string' ? err : 'Unknown error');
        } finally {
          setPushing(false);
        }
      }
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Commit failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setCommitting(false);
    }
  }, [activePath, commitMessage, amend, triggerChangesRefreshAction]);

  const stageFiles = useCallback(async (files: string[]) => {
    if (!activePath || files.length === 0) return;
    setStagingPaths((prev) => {
      const next = new Set(prev);
      for (const f of files) next.add(`stage:${f}`);
      return next;
    });
    try {
      await invoke('git_stage_files', { path: activePath, files });
    } catch (err) {
      toast.error('Stage failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setStagingPaths((prev) => {
        const next = new Set(prev);
        for (const f of files) next.delete(`stage:${f}`);
        return next;
      });
      // Refresh even on failure - with --ignore-errors / reserved-name skips a
      // batch can partially succeed and the checkboxes must reflect reality.
      triggerChangesRefreshAction();
    }
  }, [activePath, triggerChangesRefreshAction]);

  const unstageFiles = useCallback(async (files: string[]) => {
    if (!activePath || files.length === 0) return;
    setStagingPaths((prev) => {
      const next = new Set(prev);
      for (const f of files) next.add(`unstage:${f}`);
      return next;
    });
    try {
      await invoke('git_unstage_files', { path: activePath, files });
    } catch (err) {
      toast.error('Unstage failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setStagingPaths((prev) => {
        const next = new Set(prev);
        for (const f of files) next.delete(`unstage:${f}`);
        return next;
      });
      triggerChangesRefreshAction();
    }
  }, [activePath, triggerChangesRefreshAction]);

  // Quick pull - pull from upstream (or origin/<current-branch>) into the
  // currently targeted repo's branch. Mirrors VS Code's "Pull" button.
  const handleQuickPull = useCallback(async () => {
    if (!activePath || !result?.is_git_repo) return;
    setPullingTop(true);
    try {
      const upstream = await invoke<string | null>('get_upstream_branch', { path: activePath });
      let remote: string | null = null;
      let branch: string | null = null;
      if (upstream) {
        const idx = upstream.indexOf('/');
        if (idx > 0 && idx < upstream.length - 1) {
          remote = upstream.slice(0, idx);
          branch = upstream.slice(idx + 1);
        }
      }
      if (!remote || !branch) {
        // Fallback: check for origin/<current-branch>
        const refs = await invoke<string[]>('get_repo_remote_refs', { path: activePath });
        const fallback = result.branch ? `origin/${result.branch}` : null;
        if (fallback && refs.includes(fallback)) {
          remote = 'origin';
          branch = result.branch!;
        } else {
          toast.error(
            'Pull',
            'No upstream branch set. Use the branch menu in the Repositories list to pick a remote branch.',
          );
          return;
        }
      }
      const msg = await pullWithStashConfirm({
        path: activePath,
        remote,
        branch,
        strategy: 'merge',
      });
      const firstLine = msg.split('\n').find((l) => l.trim().length > 0) ?? 'Pulled';
      toast.success(`Pulled from ${remote}/${branch}`, firstLine);
      if (activeTerminalId && activeCwd && pathsEqual(activeCwd, activePath)) {
        await useTerminalStore.getState().fetchGitInfo(activeTerminalId);
      }
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Pull failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setPullingTop(false);
    }
  }, [activePath, result?.is_git_repo, result?.branch, activeTerminalId, activeCwd, triggerChangesRefreshAction]);

  const handleStash = useCallback(async () => {
    if (!activePath) return;
    setStashing(true);
    try {
      const msg = commitMessage.trim() || null;
      await invoke('git_stash_push', { path: activePath, message: msg, includeUntracked: true });
      toast.success('Stashed', msg ?? 'Working changes stashed');
      setCommitMessage('');
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Stash failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setStashing(false);
    }
  }, [activePath, commitMessage, triggerChangesRefreshAction]);

  const runStashOp = useCallback(async (
    op: 'git_stash_apply' | 'git_stash_pop' | 'git_stash_drop',
    reference: string,
    label: string,
  ) => {
    if (!activePath) return;
    setStashActing(`${op}:${reference}`);
    try {
      await invoke(op, { path: activePath, reference });
      toast.success(label, `${reference} - done`);
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error(`${label} failed`, typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setStashActing(null);
    }
  }, [activePath, triggerChangesRefreshAction]);

  // Split worktrees into "linked" (not the main repo) and tag the active one
  const linkedWorktrees = useMemo(
    () => worktrees.filter((w) => !w.is_main),
    [worktrees]
  );

  const fetchChanges = useCallback(async (silent = false) => {
    if (!activeTerminalId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = usingSelectedRepo && selectedRepoPath
        ? await invoke<FileChangesResult>('get_path_changes', { path: selectedRepoPath })
        : await invoke<FileChangesResult>('get_terminal_changes', { id: activeTerminalId });
      setResult(data);
    } catch (err) {
      setError(String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeTerminalId, selectedRepoPath, usingSelectedRepo]);

  useEffect(() => {
    fetchChanges();
  }, [activeTerminalId, changesRefreshTrigger, selectedRepoPath, fetchChanges]);

  // Collapse the expanded inline diff only when the target repo changes - NOT
  // on every refresh tick, or toggling a checkbox would close the open diff.
  useEffect(() => {
    setExpandedFile(null);
  }, [activeTerminalId, selectedRepoPath]);

  // Auto-refresh: window focus + tab visibility + slow interval while panel is mounted.
  // Silent so the spinner doesn't flash on every tick. Manual refresh button stays loud.
  const fetchRef = useRef(fetchChanges);
  useEffect(() => { fetchRef.current = fetchChanges; }, [fetchChanges]);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void fetchRef.current(true);
    };
    const interval = window.setInterval(tick, 5000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  // Merge staged + unstaged entries per path into the IntelliJ checkbox model:
  // checked = fully staged, indeterminate = partially staged.
  const mergedChanges = useMemo<MergedChange[]>(() => {
    const map = new Map<string, { stagedEntry?: FileChange; unstagedEntry?: FileChange }>();
    for (const c of result?.changes ?? []) {
      const e = map.get(c.path) ?? {};
      if (c.staged) e.stagedEntry = c; else e.unstagedEntry = c;
      map.set(c.path, e);
    }
    return Array.from(map.entries()).map(([path, e]) => ({
      path,
      status: (e.unstagedEntry ?? e.stagedEntry)!.status,
      staged: !!e.stagedEntry && !e.unstagedEntry,
      partial: !!e.stagedEntry && !!e.unstagedEntry,
    }));
  }, [result?.changes]);
  const checkedCount = mergedChanges.filter((m) => m.staged || m.partial).length;

  // Close the commit kebab menu on outside click / Escape.
  useEffect(() => {
    if (!commitMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (commitMenuRef.current && !commitMenuRef.current.contains(e.target as Node)) {
        setCommitMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCommitMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [commitMenuOpen]);

  // Splitter between Repositories and Changes - mirrors the Sidebar/Explorer
  // splitter so the user can give either section more room.
  const splitStackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const onSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const el = splitStackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = e.clientY - rect.top;
      setRepositoriesHeightRatio(y / rect.height);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setRepositoriesHeightRatio]);

  const showResizable = showGitPanel && activeTerminalId && reposExpanded;

  return (
    <RepoSelectionContext.Provider value={{ selectedRepoPath, activePath, setSelectedRepoPath }}>
    <div className="h-full bg-bg-secondary border-l border-border flex flex-col">
      {/* Header - IntelliJ commit tool window style: active "Commit" tab + icon toolbar */}
      <div className="px-2 pt-2 pb-2 border-b border-border">
        <div className="flex items-center justify-between mb-1.5">
          <span className="h-6 px-2.5 inline-flex items-center rounded-[4px] bg-elevation-3 text-text-primary text-[12px] font-medium select-none">
            Commit
          </span>
          <div className="flex items-center gap-0.5">
            <Tooltip label="Pull from upstream into the current branch">
            <button
              onClick={handleQuickPull}
              disabled={pullingTop || !activeTerminalId || !result?.is_git_repo}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06] text-success transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="Pull"
            >
              {pullingTop ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <GitPullRequestArrow size={13} strokeWidth={2} />
              )}
            </button>
            </Tooltip>
            <Tooltip label="Push commits to remote" shortcut="Ctrl+Shift+K">
            <button
              onClick={() => { if (activePath) useAppStore.getState().openPushModal(activePath); }}
              disabled={!activePath || !result?.is_git_repo}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06] text-error transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="Push"
            >
              <Upload size={13} strokeWidth={2} />
            </button>
            </Tooltip>
            <Tooltip label="Refresh">
            <button
              onClick={() => fetchChanges()}
              disabled={loading || !activeTerminalId}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06] text-accent-primary transition-colors disabled:opacity-40"
              aria-label="Refresh"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            </Tooltip>
          </div>
        </div>
        {result?.branch && (
          <div className="flex items-center gap-1.5 text-text-secondary">
            {activeGitInfo?.is_worktree ? (
              <GitFork size={12} className="text-purple-400" />
            ) : (
              <GitBranch size={12} />
            )}
            <span className="text-[11px] font-mono">{result.branch}</span>
          </div>
        )}
        {usingSelectedRepo && selectedRepoPath && (
          <div className="flex items-center justify-between mt-1 bg-accent-primary/10 ring-1 ring-inset ring-accent-primary/30 rounded-[4px] px-2 py-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <Pin size={11} className="text-accent-primary flex-shrink-0" strokeWidth={2} />
              <span className="text-[11px] text-accent-primary truncate" title={selectedRepoPath}>
                Targeting {selectedRepoPath.replace(/^.*[\\/]/, '')}
              </span>
            </div>
            <button
              onClick={() => setSelectedRepoPath(null)}
              className="flex items-center gap-0.5 text-[10.5px] text-text-secondary hover:text-text-primary transition-colors flex-shrink-0 ml-2"
              title="Clear selection - use the active terminal's repo"
            >
              <PinOff size={10} strokeWidth={2} />
              Clear
            </button>
          </div>
        )}
        {activeGitInfo?.is_worktree && activeGitInfo.main_repo_path && !usingSelectedRepo && (
          <div className="flex items-center justify-between mt-1">
            <span className="text-text-tertiary text-[11px]">
              Worktree of {activeGitInfo.main_repo_path.replace(/^.*[\\/]/, '')}
            </span>
            <button
              onClick={() => openWorktreeModal(activeGitInfo.main_repo_path!)}
              className="text-accent-primary text-[11px] hover:text-accent-secondary transition-colors"
            >
              Manage
            </button>
          </div>
        )}
      </div>

      {/* Resizable stack: Repositories (top) ⇕ Changes (bottom) */}
      <div ref={splitStackRef} className="flex-1 min-h-0 flex flex-col">
        {/* Repositories section - root repo + worktree + nested sub-repos */}
        {showGitPanel && activeTerminalId && (
          <div
            className="border-b border-border flex flex-col min-h-0"
            style={
              showResizable
                ? { flex: `${repositoriesHeightRatio} 1 0` }
                : undefined
            }
          >
            <div className="flex items-center justify-between h-[26px] px-3 flex-shrink-0">
              <button
                onClick={() => setReposExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors flex-1 min-w-0 text-left"
              >
                {reposExpanded ? (
                  <ChevronDown size={12} strokeWidth={1.75} className="flex-shrink-0" />
                ) : (
                  <ChevronRight size={12} strokeWidth={1.75} className="flex-shrink-0" />
                )}
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] flex-shrink-0">
                  Repositories
                </span>
                <span className="text-text-tertiary text-[11px]">
                  {repos.length > 0 ? `(${repos.length})` : reposLoading ? '…' : ''}
                </span>
              </button>
              <Tooltip label="Rescan">
                <button
                  onClick={() => activeCwd && fetchRepos(activeCwd)}
                  className={`w-5 h-5 flex items-center justify-center rounded-[3px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors ${
                    reposLoading ? 'animate-spin' : ''
                  }`}
                >
                  <RefreshCw size={11} strokeWidth={1.75} />
                </button>
              </Tooltip>
            </div>
            {reposExpanded && (
              <div className="px-2 pb-2 space-y-0.5 flex-1 min-h-0 overflow-y-auto">
                {!reposLoading && repos.length === 0 && (
                  <div className="text-text-tertiary text-[11px] px-2 py-1">
                    No Git repositories detected
                  </div>
                )}
                {repos.filter((r) => r.is_main_repo).map((r) => (
                  <RepoRow key={r.path} repo={r} />
                ))}


                {linkedWorktrees.length > 0 && (
                  <div className="text-text-tertiary text-[10px] uppercase tracking-wide px-2 pt-1.5">
                    Worktrees ({linkedWorktrees.length})
                  </div>
                )}
                {linkedWorktrees.map((wt) => (
                  <WorktreeRow
                    key={wt.path}
                    wt={wt}
                    isActive={activeCwd != null && pathsEqual(activeCwd, wt.path)}
                  />
                ))}

                {repos.some((r) => !r.is_main_repo) && (
                  <div className="text-text-tertiary text-[10px] uppercase tracking-wide px-2 pt-1.5">
                    Nested ({repos.filter((r) => !r.is_main_repo).length})
                  </div>
                )}
                {repos.filter((r) => !r.is_main_repo).map((r) => (
                  <RepoRow key={r.path} repo={r} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Drag handle - only meaningful when both sections share the column */}
        {showResizable && (
          <div
            onMouseDown={onSplitterMouseDown}
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize Repositories / Changes"
            className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-accent-primary/50 active:bg-accent-primary/70 transition-colors"
          />
        )}

        {/* Content */}
        <div
          className="overflow-y-auto p-1.5 min-h-0"
          style={
            showResizable
              ? { flex: `${1 - repositoriesHeightRatio} 1 0` }
              : { flex: '1 1 0' }
          }
        >
          {!activeTerminalId && (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-tertiary text-[12px]">No terminal selected</p>
            </div>
          )}

          {activeTerminalId && error && (
            <div className="p-3">
              <p className="text-red-400 text-[12px]">{error}</p>
            </div>
          )}

          {activeTerminalId && result && !result.is_git_repo && (
            <div className="flex items-center justify-center h-full px-4 text-center">
              <p className="text-text-tertiary text-[12px]">
                Not a git repository.
                {repos.length > 0 && (
                  <>
                    <br />
                    Pin a nested repository above to commit, push, and manage it here.
                  </>
                )}
              </p>
            </div>
          )}

          {activeTerminalId && result && result.is_git_repo && result.changes.length === 0 && !result.error && (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-tertiary text-[12px]">No uncommitted changes</p>
            </div>
          )}

          {activeTerminalId && result?.error && (
            <div className="p-3">
              <p className="text-red-400 text-[12px]">{result.error}</p>
            </div>
          )}

          {mergedChanges.length > 0 && activePath && result?.is_git_repo && (
            <ChangelistSection
              repoPath={result.repo_root ?? activePath}
              files={mergedChanges}
              branch={result.branch}
              onStage={stageFiles}
              onUnstage={unstageFiles}
              stagingPaths={stagingPaths}
              refreshTrigger={changesRefreshTrigger}
              expandedFile={expandedFile}
              setExpandedFile={setExpandedFile}
              terminalId={activeTerminalId}
              pathOverride={usingSelectedRepo ? selectedRepoPath : null}
            />
          )}
        </div>
      </div>

      {/* Stashes - collapsible list, only when there are stashes */}
      {result?.is_git_repo && stashes.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={() => setStashesExpanded((v) => !v)}
            className="w-full flex items-center justify-between h-[26px] px-3 text-text-secondary hover:text-text-primary transition-colors"
          >
            <div className="flex items-center gap-1.5">
              {stashesExpanded ? (
                <ChevronDown size={12} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={12} strokeWidth={1.75} />
              )}
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em]">
                Stashes
              </span>
              <span className="text-text-tertiary text-[11px]">({stashes.length})</span>
            </div>
          </button>
          {stashesExpanded && (
            <div className="px-2 pb-2 space-y-0.5">
              {stashes.map((s) => {
                const isApplying = stashActing === `git_stash_apply:${s.reference}`;
                const isPopping = stashActing === `git_stash_pop:${s.reference}`;
                const isDropping = stashActing === `git_stash_drop:${s.reference}`;
                const busy = isApplying || isPopping || isDropping;
                return (
                  <div
                    key={s.reference}
                    className="group flex items-start gap-1.5 px-2 py-1 rounded-[3px] hover:bg-white/[0.04]"
                  >
                    <Archive size={11} className="mt-[2px] flex-shrink-0 text-text-secondary" strokeWidth={1.75} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-mono text-text-secondary flex-shrink-0">
                          {s.reference}
                        </span>
                        {s.branch && (
                          <span className="text-[10px] text-text-tertiary truncate">
                            on {s.branch}
                          </span>
                        )}
                      </div>
                      <div className="text-text-tertiary text-[11px] truncate" title={s.message}>
                        {s.message}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip label="Apply (keep stash)">
                        <button
                          disabled={busy}
                          onClick={() => runStashOp('git_stash_apply', s.reference, 'Apply')}
                          className="p-1 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-40"
                        >
                          {isApplying ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        </button>
                      </Tooltip>
                      <Tooltip label="Pop (apply & drop)">
                        <button
                          disabled={busy}
                          onClick={() => runStashOp('git_stash_pop', s.reference, 'Pop')}
                          className="p-1 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-accent-primary transition-colors disabled:opacity-40"
                        >
                          {isPopping ? <Loader2 size={11} className="animate-spin" /> : <Package size={11} />}
                        </button>
                      </Tooltip>
                      <Tooltip label="Drop">
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`Drop ${s.reference}? This cannot be undone.`)) {
                              runStashOp('git_stash_drop', s.reference, 'Drop');
                            }
                          }}
                          className="p-1 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-error transition-colors disabled:opacity-40"
                        >
                          {isDropping ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Commit area - IntelliJ style: Amend row, message box, Commit / Commit and Push… */}
      {result?.is_git_repo && (
        <div className="border-t border-border p-2">
          <label className="flex items-center gap-2 mb-1.5 px-0.5 text-[12px] text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={amend}
              onChange={toggleAmend}
              disabled={committing || pushing || !lastCommit}
              className="accent-accent-primary w-[13px] h-[13px]"
            />
            <span className={amend ? 'text-text-primary' : ''}>Amend</span>
            {lastCommit && (
              <span className="text-[11px] text-text-tertiary truncate" title={lastCommit.subject}>
                {lastCommit.subject}
              </span>
            )}
          </label>
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit Message"
            rows={4}
            className="w-full bg-bg-primary ring-1 ring-inset ring-border rounded-[4px] px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary/60 resize-none"
          />
          <div className="flex items-center mt-2 gap-1.5">
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleCommit(false, 'none')}
              disabled={committing || pushing || stashing || !commitMessage.trim() || (checkedCount === 0 && !amend)}
              loading={committing && !pushing}
              title={checkedCount === 0 && !amend ? 'Check files to include them in the commit' : 'Commit checked files'}
            >
              Commit
            </Button>
            <button
              onClick={() => handleCommit(true, 'none')}
              disabled={committing || pushing || stashing || !commitMessage.trim() || (checkedCount === 0 && !amend)}
              className="flex items-center gap-1 h-7 px-2.5 rounded-[4px] text-[11.5px] text-text-primary ring-1 ring-inset ring-border hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="Commit checked files and push"
            >
              {pushing ? <Loader2 size={12} className="animate-spin" /> : null}
              Commit and Push…
            </button>
            <span className="flex-1" />
            <div className="relative" ref={commitMenuRef}>
              <Tooltip label="More actions" disabled={commitMenuOpen}>
                <button
                  onClick={() => setCommitMenuOpen((v) => !v)}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.06] text-text-secondary transition-colors"
                  aria-label="More commit actions"
                >
                  <MoreVertical size={13} />
                </button>
              </Tooltip>
              {commitMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 z-50 w-[170px] bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg overflow-hidden py-1">
                  <button
                    onClick={() => { setCommitMenuOpen(false); handleStash(); }}
                    disabled={stashing || committing || pushing || result.changes.length === 0}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/[0.04] disabled:opacity-40"
                  >
                    {stashing ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
                    Stash Changes
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="p-2 border-t border-border">
        <div className="bg-bg-primary ring-1 ring-border rounded-md p-2.5">
          {result?.working_directory && (
            <div className="flex items-center gap-1.5 mb-1">
              <FolderOpen size={11} className="text-text-tertiary shrink-0" />
              <p className="text-text-tertiary text-[11px] font-mono truncate" title={result.working_directory}>
                {result.working_directory}
              </p>
            </div>
          )}
          <p className="text-text-secondary text-[11px]">
            {result ? `${mergedChanges.length} changed file${mergedChanges.length !== 1 ? 's' : ''}` : 'Press F2 to toggle'}
          </p>
        </div>
      </div>
    </div>
    </RepoSelectionContext.Provider>
  );
}

function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function WorktreeRow({ wt, isActive }: { wt: WorktreeInfo; isActive: boolean }) {
  const displayName = wt.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || wt.path;
  return (
    <div
      className={`flex items-start gap-1.5 px-2 py-1 rounded-[3px] hover:bg-white/[0.04] ${
        isActive ? 'bg-accent-primary/10' : ''
      }`}
      title={wt.path}
    >
      <GitFork size={11} className="mt-[2px] flex-shrink-0 text-purple-400" strokeWidth={1.75} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] font-mono truncate text-purple-400">
            {wt.branch || '(detached)'}
          </span>
          {isActive && (
            <span className="text-[9px] px-1 rounded bg-accent-primary/20 text-accent-primary flex-shrink-0">
              active
            </span>
          )}
        </div>
        <div className="text-text-tertiary text-[10.5px] truncate">
          {displayName}
        </div>
      </div>
    </div>
  );
}

function RepoRow({ repo }: { repo: ScannedGitRepo }) {
  const Icon = repo.is_worktree ? GitFork : GitBranch;
  const branchColor = repo.is_worktree ? 'text-purple-400' : 'text-accent-primary';
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const activeCwd = useTerminalStore((s) => {
    const id = s.activeTerminalId;
    return id ? s.terminals.get(id)?.config.working_directory ?? null : null;
  });
  const fetchGitInfo = useTerminalStore.getState().fetchGitInfo;
  const triggerChangesRefreshAction = useAppStore.getState().triggerChangesRefresh;
  const { selectedRepoPath, activePath, setSelectedRepoPath } = useContext(RepoSelectionContext);

  const [menuOpen, setMenuOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchBase, setNewBranchBase] = useState<string>('');
  const [pullOpen, setPullOpen] = useState(false);
  const [remoteRefs, setRemoteRefs] = useState<string[]>([]);
  const [pullRef, setPullRef] = useState<string>(''); // e.g. "origin/feature-x"
  const [pullStrategy, setPullStrategy] = useState<'merge' | 'rebase' | 'ff-only'>('merge');
  const [pulling, setPulling] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isActiveTarget = activePath != null && pathsEqual(activePath, repo.path);
  const isPinned = selectedRepoPath != null && pathsEqual(selectedRepoPath, repo.path);

  const openMenu = useCallback(async () => {
    setMenuOpen(true);
    setFilter('');
    setCreateOpen(false);
    setBranchesLoading(true);
    try {
      const list = await invoke<string[]>('get_repo_branches', { path: repo.path });
      setBranches(list);
      // Pick a sensible default base for new-branch creation
      const preferred = ['master', 'main', 'develop', 'dev'];
      const base = preferred.find((p) => list.includes(p)) ?? repo.branch ?? list[0] ?? '';
      setNewBranchBase(base);
    } catch (err) {
      toast.error('Branches', typeof err === 'string' ? err : 'Failed to list branches');
      setMenuOpen(false);
    } finally {
      setBranchesLoading(false);
    }
  }, [repo.path, repo.branch]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (branch === repo.branch) { setMenuOpen(false); return; }
    setCheckoutTarget(branch);
    try {
      await invoke('checkout_branch', { path: repo.path, branch });
      toast.success('Checkout', `Switched to ${branch} in ${repo.is_main_repo ? 'root' : repo.relative_path}`);
      setMenuOpen(false);
      if (activeTerminalId && activeCwd && pathsEqual(activeCwd, repo.path)) {
        await fetchGitInfo(activeTerminalId);
      }
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Checkout failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setCheckoutTarget(null);
    }
  }, [repo.path, repo.branch, repo.is_main_repo, repo.relative_path, activeTerminalId, activeCwd, fetchGitInfo, triggerChangesRefreshAction]);

  const openPullForm = useCallback(async () => {
    setPullOpen(true);
    setCreateOpen(false);
    setPullRef('');
    try {
      const [refs, upstream] = await Promise.all([
        invoke<string[]>('get_repo_remote_refs', { path: repo.path }),
        invoke<string | null>('get_upstream_branch', { path: repo.path }),
      ]);
      setRemoteRefs(refs);
      // Prefer upstream if it is in the list; else try origin/<current-branch>
      const candidate = upstream && refs.includes(upstream)
        ? upstream
        : (repo.branch && refs.includes(`origin/${repo.branch}`) ? `origin/${repo.branch}` : '');
      setPullRef(candidate || refs[0] || '');
    } catch (err) {
      toast.error('Pull', typeof err === 'string' ? err : 'Failed to list remote branches');
      setPullOpen(false);
    }
  }, [repo.path, repo.branch]);

  const handlePull = useCallback(async () => {
    if (!pullRef) {
      toast.error('Pull', 'Select a remote branch');
      return;
    }
    const slashIdx = pullRef.indexOf('/');
    if (slashIdx <= 0 || slashIdx === pullRef.length - 1) {
      toast.error('Pull', 'Invalid remote branch format');
      return;
    }
    const remote = pullRef.slice(0, slashIdx);
    const branch = pullRef.slice(slashIdx + 1);

    setPulling(true);
    try {
      const msg = await pullWithStashConfirm({
        path: repo.path,
        remote,
        branch,
        strategy: pullStrategy,
      });
      const firstLine = msg.split('\n').find((l) => l.trim().length > 0) ?? 'Pulled';
      toast.success('Pull', firstLine);
      setMenuOpen(false);
      setPullOpen(false);
      if (activeTerminalId && activeCwd && pathsEqual(activeCwd, repo.path)) {
        await fetchGitInfo(activeTerminalId);
      }
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Pull failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setPulling(false);
    }
  }, [repo.path, pullRef, pullStrategy, activeTerminalId, activeCwd, fetchGitInfo, triggerChangesRefreshAction]);

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) {
      toast.error('Create branch', 'Enter a branch name');
      return;
    }
    if (!/^[a-zA-Z0-9_./-]+$/.test(name)) {
      toast.error('Create branch', 'Name may only contain letters, numbers, dots, hyphens, underscores, and slashes');
      return;
    }
    setCreating(true);
    try {
      await invoke('git_create_branch', {
        path: repo.path,
        name,
        base: newBranchBase || null,
      });
      toast.success('Branch created', `${name} (from ${newBranchBase || 'current'})`);
      setMenuOpen(false);
      setCreateOpen(false);
      setNewBranchName('');
      if (activeTerminalId && activeCwd && pathsEqual(activeCwd, repo.path)) {
        await fetchGitInfo(activeTerminalId);
      }
      triggerChangesRefreshAction();
    } catch (err) {
      toast.error('Create branch failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setCreating(false);
    }
  }, [repo.path, newBranchName, newBranchBase, activeTerminalId, activeCwd, fetchGitInfo, triggerChangesRefreshAction]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const filteredBranches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, filter]);

  const togglePin = () => {
    setSelectedRepoPath(isPinned ? null : repo.path);
  };

  const [openingTerminal, setOpeningTerminal] = useState(false);
  const openTerminalHere = useCallback(async () => {
    if (openingTerminal) return;
    setOpeningTerminal(true);
    try {
      const baseLabel = repo.is_main_repo
        ? (repo.path.replace(/^.*[\\/]/, '') || 'repo')
        : (repo.relative_path || repo.path.replace(/^.*[\\/]/, ''));
      await useTerminalStore.getState().openShellTerminal(baseLabel, repo.path);
      toast.success('Shell opened', `${baseLabel} - ${repo.path}`);
    } catch (err) {
      toast.error('Open terminal failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setOpeningTerminal(false);
    }
  }, [openingTerminal, repo.path, repo.relative_path, repo.is_main_repo]);

  return (
    <div
      className={`group relative rounded-[3px] ${
        isActiveTarget ? 'bg-accent-primary/[0.08] ring-1 ring-inset ring-accent-primary/25' : ''
      }`}
      ref={menuRef}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          className={`flex-1 min-w-0 flex items-start gap-1.5 px-2 py-1 rounded-[3px] text-left transition-colors ${
            menuOpen ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
          }`}
          title={`${repo.path}\nClick to switch branch or create a new one`}
        >
          <Icon size={11} className={`mt-[2px] flex-shrink-0 ${branchColor}`} strokeWidth={1.75} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`text-[11.5px] font-mono truncate ${branchColor}`}>
                {repo.branch || '(detached)'}
              </span>
              {repo.dirty && <CircleDot size={9} className="text-warning flex-shrink-0" strokeWidth={2} />}
              {repo.ahead > 0 && (
                <span className="flex items-center text-[10px] text-text-tertiary">
                  <ArrowUp size={9} strokeWidth={2} />{repo.ahead}
                </span>
              )}
              {repo.behind > 0 && (
                <span className="flex items-center text-[10px] text-text-tertiary">
                  <ArrowDown size={9} strokeWidth={2} />{repo.behind}
                </span>
              )}
              {isActiveTarget && (
                <span className="text-[9px] px-1 rounded bg-accent-primary/20 text-accent-primary flex-shrink-0 ml-auto">
                  active
                </span>
              )}
              <ChevronDown size={10} strokeWidth={2} className={`text-text-tertiary flex-shrink-0 ${isActiveTarget ? '' : 'ml-auto'}`} />
            </div>
            <div className="text-text-tertiary text-[10.5px] truncate">
              {repo.is_main_repo ? 'root' : repo.relative_path}
              {repo.is_worktree ? ' · worktree' : ''}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={openTerminalHere}
          disabled={openingTerminal}
          className="flex-shrink-0 w-6 h-6 mt-0.5 flex items-center justify-center rounded-[3px] transition-colors text-text-tertiary hover:bg-accent-primary/15 hover:text-accent-primary disabled:opacity-40"
          title={`Open shell here\nLaunches a plain interactive shell (no Claude) at\n${repo.path}\nin the bottom terminal pane.`}
          aria-label={`Open shell in ${repo.path}`}
        >
          {openingTerminal ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <TerminalSquare size={11} strokeWidth={1.75} />
          )}
        </button>

        <Tooltip label={isPinned ? 'Unpin - use active terminal repo' : 'Pin as commit target'}>
          <button
            type="button"
            onClick={togglePin}
            className={`flex-shrink-0 w-6 h-6 mt-0.5 flex items-center justify-center rounded-[3px] transition-colors ${
              isPinned
                ? 'text-accent-primary bg-accent-primary/15 hover:bg-accent-primary/25'
                : 'text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-text-secondary'
            }`}
          >
            {isPinned ? <Pin size={11} strokeWidth={2} /> : <Pin size={11} strokeWidth={1.75} />}
          </button>
        </Tooltip>
      </div>

      {menuOpen && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg overflow-hidden">
          <div className="p-2 border-b border-[var(--ij-divider-soft)]">
            <div className="relative">
              <SearchIcon size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" strokeWidth={1.75} />
              <input
                autoFocus
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter branches…"
                className="w-full bg-elevation-0 ring-1 ring-inset ring-[var(--ij-divider)] rounded-[4px] h-7 pl-7 pr-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary/60"
              />
            </div>
          </div>

          {createOpen && (
            <div className="p-2 space-y-2 border-b border-[var(--ij-divider-soft)]">
              <input
                autoFocus
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !creating) handleCreateBranch(); }}
                placeholder="new-branch-name"
                className="w-full bg-elevation-0 ring-1 ring-inset ring-[var(--ij-divider)] rounded-[4px] h-7 px-2 text-[12px] font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary/60"
              />
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-text-tertiary flex-shrink-0">from</span>
                <select
                  value={newBranchBase}
                  onChange={(e) => setNewBranchBase(e.target.value)}
                  className="flex-1 bg-elevation-0 ring-1 ring-inset ring-[var(--ij-divider)] rounded-[4px] h-7 px-1.5 text-[12px] font-mono text-text-primary focus:outline-none focus:ring-accent-primary/60"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setCreateOpen(false); setNewBranchName(''); }}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreateBranch}
                  disabled={creating || !newBranchName.trim() || !newBranchBase}
                  loading={creating}
                >
                  Create
                </Button>
              </div>
            </div>
          )}

          {pullOpen && (
            <div className="p-2 space-y-2 border-b border-[var(--ij-divider-soft)]">
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-text-tertiary flex-shrink-0">from</span>
                <select
                  autoFocus
                  value={pullRef}
                  onChange={(e) => setPullRef(e.target.value)}
                  className="flex-1 bg-elevation-0 ring-1 ring-inset ring-[var(--ij-divider)] rounded-[4px] h-7 px-1.5 text-[12px] font-mono text-text-primary focus:outline-none focus:ring-accent-primary/60"
                >
                  {remoteRefs.length === 0 && <option value="">(no remote branches)</option>}
                  {remoteRefs.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1 text-[10.5px]">
                <span className="text-text-tertiary flex-shrink-0 mr-1">strategy</span>
                {(['merge', 'rebase', 'ff-only'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setPullStrategy(s)}
                    className={`h-6 px-1.5 rounded-[3px] font-mono transition-colors ${
                      pullStrategy === s
                        ? 'bg-accent-primary/20 text-accent-primary ring-1 ring-inset ring-accent-primary/40'
                        : 'text-text-secondary hover:bg-white/[0.06]'
                    }`}
                  >
                    {s === 'ff-only' ? 'ff-only' : s}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] text-text-tertiary truncate" title={`Into ${repo.branch ?? '(detached)'}`}>
                  into <span className="font-mono text-text-secondary">{repo.branch ?? '(detached)'}</span>
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPullOpen(false)}
                    disabled={pulling}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handlePull}
                    disabled={pulling || !pullRef}
                    loading={pulling}
                  >
                    Pull
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!createOpen && !pullOpen && (
            <>
              <button
                onClick={() => setCreateOpen(true)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
              >
                <Plus size={12} strokeWidth={2} />
                <span>Create new branch…</span>
              </button>
              <button
                onClick={openPullForm}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-accent-primary hover:bg-accent-primary/10 transition-colors border-b border-[var(--ij-divider-soft)]"
              >
                <GitPullRequestArrow size={12} strokeWidth={2} />
                <span>Pull into <span className="font-mono">{repo.branch ?? '(detached)'}</span>…</span>
              </button>
            </>
          )}

          <div className="max-h-[260px] overflow-y-auto py-1">
            {branchesLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-text-tertiary text-[12px]">
                <Loader2 size={12} className="animate-spin" />
                Loading branches…
              </div>
            )}
            {!branchesLoading && filteredBranches.length === 0 && (
              <div className="px-3 py-2 text-text-tertiary text-[12px]">
                {branches.length === 0 ? 'No branches' : 'No match'}
              </div>
            )}
            {!branchesLoading && filteredBranches.map((b) => {
              const isCurrent = b === repo.branch;
              const isChecking = checkoutTarget === b;
              return (
                <button
                  key={b}
                  onClick={() => handleCheckout(b)}
                  disabled={isChecking || isCurrent}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-mono text-left transition-colors ${
                    isCurrent
                      ? 'text-accent-primary bg-accent-primary/10 cursor-default'
                      : 'text-text-primary hover:bg-white/[0.05]'
                  }`}
                >
                  <span className="truncate">{b}</span>
                  {isChecking ? (
                    <Loader2 size={11} className="animate-spin text-text-tertiary flex-shrink-0" />
                  ) : isCurrent ? (
                    <Check size={12} className="text-accent-primary flex-shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
