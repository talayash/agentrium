import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FolderOpen, Terminal, Zap, GitBranch, GitFork, Plus, Loader2, ChevronDown, Check, Pencil, Pin, PinOff, Trash2, SlidersHorizontal } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, NEW_PROFILE_ID } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import type { WorktreeInfo, WorktreeDetectResult } from '../types/git';
import { reportInvokeFailure } from '../lib/errorReporter';
import { toast } from '../store/toastStore';
import { filterArgsForAgent, specFor, type AgentKind } from '../lib/agents';
import { AgentPicker } from './AgentPicker';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ListRow } from './ui/ListRow';
import { Toggle } from './ui/Toggle';

const isMac = navigator.platform.toUpperCase().includes('MAC');

interface PreviewProfile {
  enabled: boolean;
  url_override?: string | null;
  framework_hint?: string | null;
}

interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  is_default: boolean;
  agent: AgentKind;
  preview?: PreviewProfile | null;
  // Per-agent args map. When the modal's selectedAgent switches, the args
  // textarea should reflect that agent's stored entry from this profile
  // (falling back to claude_args if none is stored - e.g. legacy rows).
  agent_args?: Partial<Record<AgentKind, string[]>>;
}

const TAG_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-green-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-pink-500',
];

export function NewTerminalModal() {
  const { closeNewTerminalModal, defaultAgentArgs, openProfileModal, profileModalOpen, gridMode, addToGrid } = useAppStore();
  const pinnedProfileIds = useAppStore((s) => s.pinnedProfileIds);
  const toggleProfilePin = useAppStore((s) => s.toggleProfilePin);
  const { terminals, createTerminal, createShellTerminalTab } = useTerminalStore();

  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [claudeArgs, setClaudeArgs] = useState<string[]>(defaultAgentArgs.claude);
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultDirectory, setDefaultDirectory] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [selectedModel, setSelectedModel] = useState<'default' | 'opus' | 'sonnet' | 'haiku'>('default');
  const [selectedEffort, setSelectedEffort] = useState<'default' | 'low' | 'medium' | 'high'>('default');
  const [plainShell, setPlainShell] = useState(false);
  // Welcome-screen agent cards open this modal with an agent preselected;
  // read once on mount (the modal is unmounted while closed).
  const preselectedAgent = useAppStore.getState().newTerminalPreselectedAgent;
  const [selectedAgent, setSelectedAgent] = useState<AgentKind>(preselectedAgent ?? 'claude');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Two-step inline delete: first trash click arms this id, the red confirm
  // deletes. Leaves the row (or picking another) disarms.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const handleDeleteProfile = async (id: string) => {
    setConfirmingDeleteId(null);
    try {
      const name = profiles.find((p) => p.id === id)?.name || 'Profile';
      await invoke('delete_profile', { id });
      if (selectedProfileId === id) setSelectedProfileId(null);
      if (pinnedProfileIds.includes(id)) toggleProfilePin(id);
      await loadProfiles();
      toast.success('Profile deleted', `"${name}" has been removed.`);
    } catch (err) {
      toast.error('Delete failed', String(err));
      reportInvokeFailure('delete_profile', err);
    }
  };

  // Worktree state
  const [worktreeDetect, setWorktreeDetect] = useState<WorktreeDetectResult | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [showNewWorktreeForm, setShowNewWorktreeForm] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [newWorktreePath, setNewWorktreePath] = useState('');
  const [detectingGit, setDetectingGit] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const detectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadProfiles();
    loadDefaultDirectory();
  }, []);

  // Reload profiles when the ProfileModal closes - picks up any add/edit/delete
  // the user just made without forcing them to reopen New Terminal.
  const prevProfileModalOpen = useRef(profileModalOpen);
  useEffect(() => {
    if (prevProfileModalOpen.current && !profileModalOpen) {
      loadProfiles();
    }
    prevProfileModalOpen.current = profileModalOpen;
  }, [profileModalOpen]);

  // Profile-scoped fields (working directory + env vars) only reset when the
  // profile itself changes. Keeping them out of the args-resolution effect
  // below means switching agent AFTER picking a project doesn't clobber the
  // user's chosen directory. Bug: previously typing/browsing a WD and then
  // clicking a different agent snapped WD back to the profile's default,
  // making Antigravity (and any post-picked agent) spawn in the wrong dir.
  useEffect(() => {
    if (selectedProfileId) {
      const profile = profiles.find(p => p.id === selectedProfileId);
      if (profile) {
        setWorkingDirectory(profile.working_directory || defaultDirectory);
        setEnvVars(profile.env_vars || {});
      }
    } else {
      setWorkingDirectory(defaultDirectory);
      setEnvVars({});
    }
  }, [selectedProfileId, profiles, defaultDirectory]);

  // Args are per-agent, so they must resync on either profile OR agent change.
  // Resolution priority:
  //   1. profile.agent_args[selectedAgent]  - what the user saved for this
  //      specific agent inside this profile
  //   2. profile.claude_args (only when selectedAgent matches the profile's
  //      default agent) - legacy fallback for pre-multi-agent rows
  //   3. defaultAgentArgs[selectedAgent] - the global per-agent starter
  // Without step 1 the args field looked "stuck" when switching agent while
  // a profile was selected (every agent got the same list).
  useEffect(() => {
    if (selectedProfileId) {
      const profile = profiles.find(p => p.id === selectedProfileId);
      if (profile) {
        const savedForAgent = profile.agent_args?.[selectedAgent];
        const legacyForDefault =
          selectedAgent === profile.agent && profile.claude_args.length > 0
            ? profile.claude_args
            : undefined;
        const resolved =
          savedForAgent && savedForAgent.length > 0
            ? savedForAgent
            : legacyForDefault ?? defaultAgentArgs[selectedAgent];
        setClaudeArgs(resolved);
      }
    } else {
      setClaudeArgs(defaultAgentArgs[selectedAgent]);
    }
  }, [selectedProfileId, profiles, defaultAgentArgs, selectedAgent]);

  // Debounced git detection when working directory changes
  const detectGitRepo = useCallback(async (dir: string) => {
    if (!dir.trim()) {
      setWorktreeDetect(null);
      setWorktrees([]);
      setBranches([]);
      return;
    }
    setDetectingGit(true);
    try {
      const info = await invoke<WorktreeDetectResult>('get_worktree_info', { path: dir });
      setWorktreeDetect(info);

      if (info.is_git_repo) {
        // Resolve repo path for listing worktrees
        const repoPath = info.is_worktree && info.main_repo_path
          ? info.main_repo_path
          : dir;

        const [wts, brs] = await Promise.all([
          invoke<WorktreeInfo[]>('list_worktrees', { path: repoPath }),
          invoke<string[]>('get_repo_branches', { path: repoPath }),
        ]);
        setWorktrees(wts);
        setBranches(brs);
        setSelectedWorktreePath(null);
        if (brs.length > 0 && !baseBranch) {
          setBaseBranch(brs[0]);
        }
      } else {
        setWorktrees([]);
        setBranches([]);
      }
    } catch {
      setWorktreeDetect(null);
      setWorktrees([]);
      setBranches([]);
    } finally {
      setDetectingGit(false);
    }
  }, [baseBranch]);

  useEffect(() => {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    detectTimerRef.current = setTimeout(() => {
      detectGitRepo(workingDirectory);
    }, 500);
    return () => {
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    };
  }, [workingDirectory, detectGitRepo]);

  // Auto-generate worktree path from branch name
  useEffect(() => {
    if (newBranchName && worktreeDetect?.is_git_repo) {
      const repoPath = worktreeDetect.is_worktree && worktreeDetect.main_repo_path
        ? worktreeDetect.main_repo_path
        : workingDirectory;
      const parentDir = repoPath.replace(/[\\/][^\\/]*$/, '');
      const repoName = repoPath.replace(/^.*[\\/]/, '');
      const sanitized = newBranchName.replace(/\//g, '-');
      // Match the repo path's separator so the prefilled path is valid on
      // macOS/Linux too (hardcoding '\\' produced broken paths there).
      const sep = repoPath.includes('\\') ? '\\' : '/';
      setNewWorktreePath(`${parentDir}${sep}${repoName}-${sanitized}`);
    }
  }, [newBranchName, worktreeDetect, workingDirectory]);

  const handleCreateWorktree = async () => {
    if (!newBranchName.trim() || !newWorktreePath.trim()) return;
    setCreatingWorktree(true);
    setWorktreeError(null);
    try {
      const repoPath = worktreeDetect?.is_worktree && worktreeDetect.main_repo_path
        ? worktreeDetect.main_repo_path
        : workingDirectory;

      const branchExists = branches.includes(newBranchName);
      const wt = await invoke<WorktreeInfo>('create_worktree', {
        repoPath,
        worktreePath: newWorktreePath,
        branch: newBranchName,
        createBranch: !branchExists,
      });

      // Add to list and select it
      setWorktrees(prev => [...prev, wt]);
      setSelectedWorktreePath(wt.path);
      setWorkingDirectory(wt.path);
      setShowNewWorktreeForm(false);
      setNewBranchName('');
    } catch (err) {
      setWorktreeError(String(err));
    } finally {
      setCreatingWorktree(false);
    }
  };

  const loadProfiles = async () => {
    try {
      const loadedProfiles = await invoke<ConfigProfile[]>('get_profiles');
      setProfiles(loadedProfiles);

      // Select default profile if exists
      const defaultProfile = loadedProfiles.find(p => p.is_default);
      if (defaultProfile) {
        // Align selectedAgent with the default profile's agent so the deselect
        // effect doesn't immediately null this selection - unless the caller
        // preselected an agent (welcome-screen card): that explicit choice wins.
        if (!preselectedAgent) {
          setSelectedAgent(defaultProfile.agent);
        }
        setSelectedProfileId(defaultProfile.id);
      }
    } catch (error) {
      reportInvokeFailure('get_profiles', error);
    }
  };

  const loadDefaultDirectory = async () => {
    try {
      const home = await homeDir();
      setWorkingDirectory(home);
      setDefaultDirectory(home);
    } catch (error) {
      reportInvokeFailure('home_dir', error);
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: workingDirectory,
      });
      if (selected && typeof selected === 'string') {
        setWorkingDirectory(selected);
      }
    } catch (error) {
      reportInvokeFailure('dialog_open_directory', error);
    }
  };

  const handleCreateTerminal = async () => {
    setError(null);

    if (!workingDirectory.trim()) {
      setError('Working directory is required.');
      return;
    }

    setIsCreating(true);
    try {
      const selectedProfile = profiles.find(p => p.id === selectedProfileId);
      const baseName = plainShell ? 'Shell' : (selectedProfile?.name || 'Terminal');
      const label = `${baseName} ${terminals.size + 1}`;
      const colorTag = TAG_COLORS[terminals.size % TAG_COLORS.length];

      let newTerminalId: string;
      if (plainShell) {
        newTerminalId = await createShellTerminalTab(
          label,
          workingDirectory,
          colorTag,
          nickname || undefined,
        );
      } else {
        const dangerousPattern = /[;&|`$(){}<>^\n\r'"\\~*?[\]!#\t]/;
        for (const arg of claudeArgs) {
          if (dangerousPattern.test(arg)) {
            setError(`Invalid character in argument: "${arg}". Remove shell metacharacters.`);
            setIsCreating(false);
            return;
          }
        }

        // Strip Claude-only flags when the target isn't Claude (e.g., a
        // saved profile with --dangerously-skip-permissions being reused
        // with Codex, which rejects it). filterArgsForAgent is a no-op
        // shallow copy for Claude.
        const finalArgs = filterArgsForAgent(selectedAgent, claudeArgs);
        // Model / Effort / Worktree flags are Claude Code specific. Only
        // inject them when spawning Claude - Codex and Cursor have their
        // own selectors (out of scope for MVP) and would arg-parse-fail
        // on these names.
        if (selectedAgent === 'claude') {
          if (selectedModel !== 'default') {
            finalArgs.unshift('--model', selectedModel);
          }
          if (selectedEffort !== 'default') {
            finalArgs.unshift('--effort', selectedEffort);
          }
          if (useWorktree) {
            finalArgs.unshift('--worktree');
          }
        }

        const previewInit = selectedProfile?.preview?.enabled
          ? {
              isOpen: true,
              userOverride: selectedProfile.preview.url_override ?? null,
              frameworkHint: (selectedProfile.preview.framework_hint ?? 'unknown') as
                import('../lib/preview/framework').FrameworkHint,
            }
          : undefined;

        newTerminalId = await createTerminal(
          label,
          workingDirectory,
          finalArgs,
          envVars,
          colorTag,
          nickname || undefined,
          undefined,
          undefined,
          undefined,
          previewInit,
          selectedAgent,
        );
      }

      // Created from grid view → place the new terminal in the grid so it's
      // visible immediately. addToGrid dedupes and caps at 8, so a full grid
      // gracefully no-ops on placement (the terminal is still created/active).
      if (gridMode) {
        addToGrid(newTerminalId);
      }

      closeNewTerminalModal();
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('create_terminal', err);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Modal
      onClose={closeNewTerminalModal}
      closeOn="doubleClick"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-full max-w-lg max-h-[90vh] flex flex-col"
      showHeader
      title={plainShell ? 'New Shell' : 'New Session'}
      icon={<Terminal size={16} className="text-text-secondary" />}
    >
        {/* Content - ordered by decision priority: WHO runs (agent) → WHAT
            setup (profile) → WHERE (folder) → details. Rarely-touched knobs
            live behind the Advanced disclosure. */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
          {/* Agent */}
          {!plainShell && (
            <div>
              <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">Agent</label>
              <AgentPicker value={selectedAgent} onChange={setSelectedAgent} />
            </div>
          )}

          {/* Profile - a grouped single-column list (iOS Settings inset
              style): every profile visible, one click to select, no popup.
              Consistent row structure keeps many Hebrew-named profiles calm
              where free-flowing chips read as clutter. */}
          {!plainShell && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-text-tertiary text-[11px] font-semibold uppercase tracking-wider">Profile</label>
                <button
                  onClick={() => openProfileModal(NEW_PROFILE_ID)}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-accent-primary text-white text-[11.5px] font-semibold hover:bg-accent-secondary active:scale-[0.97] transition-[background-color,transform] duration-100"
                >
                  <Plus size={12} strokeWidth={2.5} />
                  New Profile
                </button>
              </div>
              <div className="rounded-xl ring-1 ring-seam bg-elevation-2 divide-y divide-[var(--seam)] max-h-[218px] overflow-y-auto">
                <button
                  type="button"
                  aria-pressed={selectedProfileId === null}
                  onClick={() => setSelectedProfileId(null)}
                  className={`w-full flex items-center gap-2.5 px-3 h-[42px] text-left transition-colors ${
                    selectedProfileId === null ? 'bg-accent-primary/10' : 'hover:bg-fill-hover'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-text-primary text-[12.5px] font-medium leading-tight">No Profile</p>
                    <p className="text-text-tertiary text-[11px] leading-tight">Custom settings</p>
                  </div>
                  {selectedProfileId === null && (
                    <Check size={14} className="text-accent-primary flex-shrink-0" strokeWidth={2.25} />
                  )}
                </button>
                {[...profiles.filter((p) => pinnedProfileIds.includes(p.id)),
                  ...profiles.filter((p) => !pinnedProfileIds.includes(p.id))].map((profile) => {
                  const isSel = selectedProfileId === profile.id;
                  const isPinned = pinnedProfileIds.includes(profile.id);
                  const isConfirmingDelete = confirmingDeleteId === profile.id;
                  const info = [profile.description, profile.working_directory].filter(Boolean).join(' · ');
                  return (
                    <div
                      key={profile.id}
                      className="group relative"
                      onMouseLeave={() => { if (isConfirmingDelete) setConfirmingDeleteId(null); }}
                    >
                      <button
                        type="button"
                        aria-pressed={isSel}
                        onClick={() => setSelectedProfileId(profile.id)}
                        className={`w-full flex items-center gap-2 px-3 h-[42px] pr-28 text-left transition-colors ${
                          isSel ? 'bg-accent-primary/10' : 'hover:bg-fill-hover'
                        }`}
                      >
                        {isPinned && (
                          <Pin size={11} className="text-accent-primary flex-shrink-0" aria-label="Pinned" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-text-primary text-[12.5px] font-medium truncate leading-tight">{profile.name}</p>
                          {info && <p className="text-text-tertiary text-[11px] truncate leading-tight">{info}</p>}
                        </div>
                      </button>
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        {isConfirmingDelete ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleDeleteProfile(profile.id); }}
                            className="h-6 px-2 rounded-md bg-error text-white text-[11px] font-medium hover:brightness-110 transition-[filter]"
                          >
                            Delete?
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleProfilePin(profile.id); }}
                              title={isPinned ? 'Unpin' : 'Pin to top'}
                              aria-label={isPinned ? `Unpin ${profile.name}` : `Pin ${profile.name} to top`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-fill-active hover:text-text-primary transition-[opacity,background-color]"
                            >
                              {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); openProfileModal(profile.id); }}
                              title="Edit profile"
                              aria-label={`Edit profile ${profile.name}`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-fill-active hover:text-text-primary transition-[opacity,background-color]"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setConfirmingDeleteId(profile.id); }}
                              title="Delete profile"
                              aria-label={`Delete profile ${profile.name}`}
                              className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-error/15 hover:text-error transition-[opacity,background-color,color]"
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                        {isSel && (
                          <Check size={14} className="text-accent-primary flex-shrink-0" strokeWidth={2.25} />
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Working Directory */}
          <div>
            <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                className="flex-1 bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                placeholder={isMac ? "/path/to/project" : "C:\\path\\to\\project"}
              />
              <button
                onClick={handleBrowseDirectory}
                className="px-3 h-9 bg-elevation-2 ring-1 ring-seam rounded-lg hover:bg-fill-hover transition-colors"
              >
                <FolderOpen size={16} className="text-text-secondary" />
              </button>
            </div>
          </div>

          {/* Git Worktrees */}
          <AnimatePresence>
            {worktreeDetect?.is_git_repo && worktrees.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <label className="text-text-secondary text-[12px]">
                      Git Worktrees
                    </label>
                    {detectingGit && <Loader2 size={12} className="text-text-tertiary animate-spin" />}
                  </div>
                  <button
                    onClick={() => {
                      setShowNewWorktreeForm(!showNewWorktreeForm);
                      setWorktreeError(null);
                    }}
                    className="flex items-center gap-1 text-[11px] text-accent-primary hover:text-accent-secondary transition-colors"
                  >
                    <Plus size={12} />
                    New Worktree
                  </button>
                </div>

                {worktreeDetect.is_worktree && worktreeDetect.main_repo_path && (
                  <p className="text-[11px] text-text-tertiary mb-1.5">
                    Worktree of <span className="text-text-secondary font-medium">{worktreeDetect.main_repo_path.replace(/^.*[\\/]/, '')}</span>
                  </p>
                )}

                <div className="space-y-1 max-h-[120px] overflow-y-auto">
                  {worktrees.map((wt) => {
                    const isSelected = selectedWorktreePath === wt.path
                      || (!selectedWorktreePath && wt.path.replace(/\//g, '\\') === workingDirectory.replace(/\//g, '\\'));
                    return (
                      <ListRow
                        key={wt.path}
                        selected={isSelected}
                        onClick={() => {
                          setSelectedWorktreePath(wt.path);
                          setWorkingDirectory(wt.path);
                        }}
                        className="items-start py-1.5"
                        leading={
                          wt.is_main ? (
                            <GitBranch size={13} className="text-accent-primary flex-shrink-0" />
                          ) : (
                            <GitFork size={13} className="text-purple-400 flex-shrink-0" />
                          )
                        }
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-text-primary text-[12px] font-mono truncate">
                            {wt.branch || '(detached)'}
                            {wt.is_main && <span className="text-text-tertiary font-sans"> (main)</span>}
                          </p>
                          <p className="text-text-tertiary text-[11px] truncate">{wt.path}</p>
                        </div>
                      </ListRow>
                    );
                  })}
                </div>

                {/* New Worktree Form */}
                <AnimatePresence>
                  {showNewWorktreeForm && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.15 }}
                      className="mt-2 p-2.5 rounded-md bg-bg-primary ring-1 ring-border space-y-2"
                    >
                      <div>
                        <label className="block text-text-tertiary text-[11px] mb-1">Branch name</label>
                        <input
                          type="text"
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          placeholder="feature/my-branch"
                          className="w-full bg-elevation-2 ring-1 ring-seam rounded-md h-8 px-2.5 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-text-tertiary text-[11px] mb-1">Base branch</label>
                        <div className="relative">
                          <select
                            value={baseBranch}
                            onChange={(e) => setBaseBranch(e.target.value)}
                            className="w-full bg-bg-secondary ring-1 ring-border-light rounded h-8 px-2.5 pr-8 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors appearance-none"
                          >
                            {branches.map(b => (
                              <option key={b} value={b}>{b}</option>
                            ))}
                          </select>
                          <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-text-tertiary text-[11px] mb-1">Worktree path</label>
                        <input
                          type="text"
                          value={newWorktreePath}
                          onChange={(e) => setNewWorktreePath(e.target.value)}
                          dir="ltr"
                          className="w-full bg-bg-secondary ring-1 ring-border-light rounded h-8 px-2.5 text-text-primary text-[12px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                        />
                      </div>
                      {worktreeError && (
                        <p className="text-error text-[11px]">{worktreeError}</p>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setShowNewWorktreeForm(false);
                            setWorktreeError(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleCreateWorktree}
                          disabled={!newBranchName.trim()}
                          loading={creatingWorktree}
                        >
                          {creatingWorktree ? 'Creating...' : 'Create'}
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Details: nickname + (Claude) model - the two things people
              actually tweak per-session. */}
          <div>
            <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">
              Nickname <span className="normal-case font-normal tracking-normal text-text-tertiary/70">(optional)</span>
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g., My Project, Backend API"
              className="w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
            />
          </div>

          {!plainShell && selectedAgent === 'claude' && (
          <div>
            <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">Model</label>
            <div className="flex gap-1.5">
              {(['default', 'opus', 'sonnet', 'haiku'] as const).map((model) => (
                <button
                  key={model}
                  onClick={() => setSelectedModel(model)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                    selectedModel === model
                      ? model === 'opus' ? 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/30'
                      : model === 'sonnet' ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                      : model === 'haiku' ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30'
                      : 'bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30'
                      : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active hover:text-text-primary'
                  }`}
                >
                  {model === 'default' ? 'Default' : model.charAt(0).toUpperCase() + model.slice(1)}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Advanced - rarely-touched knobs, folded away so the main flow
              stays three glances long. */}
          <div className="rounded-xl ring-1 ring-seam overflow-hidden">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="w-full flex items-center gap-2 px-3.5 h-10 text-left hover:bg-fill-hover transition-colors"
            >
              <SlidersHorizontal size={13} className="text-text-tertiary" strokeWidth={1.75} />
              <span className="text-[12.5px] font-medium text-text-primary flex-1">Advanced</span>
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={`text-text-tertiary transition-transform duration-150 ${showAdvanced ? 'rotate-180' : ''}`}
              />
            </button>
            <AnimatePresence initial={false}>
              {showAdvanced && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="overflow-hidden"
                >
                  <div className="px-3.5 pb-3.5 pt-1 space-y-4 border-t border-seam">
                    {/* Arguments */}
                    {!plainShell && (
                    <div>
                      <label className="block text-text-secondary text-[12px] mb-1.5 mt-2">
                        {specFor(selectedAgent).displayName} Arguments (one per line)
                      </label>
                      <textarea
                        value={claudeArgs.join('\n')}
                        onChange={(e) => setClaudeArgs(e.target.value.split('\n').filter(Boolean))}
                        className="w-full bg-elevation-2 ring-1 ring-seam rounded-lg py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 font-mono h-20 resize-none transition-colors"
                        placeholder={specFor(selectedAgent).defaultArgsHint}
                      />
                      <p className="text-text-tertiary text-[11px] mt-1 truncate">
                        Command: <code className="text-text-secondary">{specFor(selectedAgent).binary} {claudeArgs.join(' ')}</code>
                      </p>
                    </div>
                    )}

                    {/* Effort - Claude-only flag */}
                    {!plainShell && selectedAgent === 'claude' && (
                    <div>
                      <label className="block text-text-secondary text-[12px] mb-1.5">Effort</label>
                      <div className="flex gap-1.5">
                        {(['default', 'low', 'medium', 'high'] as const).map((effort) => (
                          <button
                            key={effort}
                            onClick={() => setSelectedEffort(effort)}
                            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                              selectedEffort === effort
                                ? 'bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30'
                                : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active hover:text-text-primary'
                            }`}
                          >
                            {effort === 'default' ? 'Default' : effort.charAt(0).toUpperCase() + effort.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    )}

                    {/* Isolated Worktree - Claude-only flag */}
                    {!plainShell && selectedAgent === 'claude' && (
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-text-secondary text-[12px]">Isolated Worktree</label>
                        <p className="text-text-tertiary text-[11px]">Run in a separate git worktree</p>
                      </div>
                      <Toggle checked={useWorktree} onChange={setUseWorktree} ariaLabel="Isolated Worktree" />
                    </div>
                    )}

                    {/* Plain shell mode */}
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-text-secondary text-[12px]">Plain shell (no agent)</label>
                        <p className="text-text-tertiary text-[11px]">
                          Run a regular shell so you can launch wrappers like <code className="text-text-secondary">ollama launch claude</code>
                        </p>
                      </div>
                      <div className="ml-3">
                        <Toggle checked={plainShell} onChange={setPlainShell} ariaLabel="Plain shell (no agent)" />
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {error && (
            <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20">
              <p className="text-error text-[12px]">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-3 border-t border-seam">
          <Button variant="ghost" onClick={closeNewTerminalModal}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreateTerminal}
            disabled={!workingDirectory}
            loading={isCreating}
            icon={<Zap size={14} />}
          >
            {isCreating ? 'Creating...' : (plainShell ? 'Start Shell' : 'Start Session')}
          </Button>
        </div>
    </Modal>
  );
}
