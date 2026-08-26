import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FolderOpen, Terminal, Zap, GitBranch, GitFork, Plus, Loader2, ChevronDown, Pencil } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import type { WorktreeInfo, WorktreeDetectResult } from '../types/git';
import { reportInvokeFailure } from '../lib/errorReporter';
import { filterArgsForAgent, specFor, type AgentKind } from '../lib/agents';
import { AgentPicker } from './AgentPicker';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ListRow } from './ui/ListRow';

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
  const [selectedAgent, setSelectedAgent] = useState<AgentKind>('claude');

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

  useEffect(() => {
    // When a profile is selected, apply its working dir / args / env, but
    // DO NOT sync selectedAgent to the profile's agent. The user's most
    // recent agent choice always wins - clicking a profile after picking
    // Codex/Cursor shouldn't snap back to Claude. The default profile's
    // agent is only used as the initial seed (see loadProfiles).
    //
    // For args: profile args win when a profile is selected. When "No
    // Profile" is selected, args = the CURRENT agent's defaults - so
    // switching between Claude/Codex/Cursor/Gemini (with no profile)
    // reflects the right agent-specific starter set. `selectedAgent` is
    // in the deps for this reason.
    if (selectedProfileId) {
      const profile = profiles.find(p => p.id === selectedProfileId);
      if (profile) {
        setWorkingDirectory(profile.working_directory || defaultDirectory);
        setClaudeArgs(profile.claude_args.length > 0 ? profile.claude_args : defaultAgentArgs[selectedAgent]);
        setEnvVars(profile.env_vars || {});
      }
    } else {
      // Reset to the selected agent's defaults when "No Profile" is picked.
      setWorkingDirectory(defaultDirectory);
      setClaudeArgs(defaultAgentArgs[selectedAgent]);
      setEnvVars({});
    }
  }, [selectedProfileId, profiles, defaultDirectory, defaultAgentArgs, selectedAgent]);

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
        // effect doesn't immediately null this selection.
        setSelectedAgent(defaultProfile.agent);
        setSelectedProfileId(defaultProfile.id);
      }
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const loadDefaultDirectory = async () => {
    try {
      const home = await homeDir();
      setWorkingDirectory(home);
      setDefaultDirectory(home);
    } catch (error) {
      console.error('Failed to get home directory:', error);
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
      console.error('Failed to open directory picker:', error);
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
      title="New Terminal"
      icon={<Terminal size={16} className="text-text-secondary" />}
    >
        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Nickname */}
          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">
              Nickname
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g., My Project, Backend API"
              className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
            />
          </div>

          {/* Plain Shell Toggle */}
          <div className="flex items-center justify-between border-t border-[var(--ij-divider-soft)] pt-4">
            <div>
              <label className="text-text-secondary text-[12px]">Plain shell (no Claude)</label>
              <p className="text-text-tertiary text-[11px]">
                Run a regular shell so you can launch wrappers like <code className="text-text-secondary">ollama launch claude</code>
              </p>
            </div>
            <button
              onClick={() => setPlainShell(!plainShell)}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ml-3 ${
                plainShell ? 'bg-accent-primary' : 'bg-border-light'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  plainShell ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Agent Selection */}
          {!plainShell && (
            <div className="border-t border-[var(--ij-divider-soft)] pt-4">
              <label className="block text-text-secondary text-[12px] mb-1.5">Agent</label>
              <AgentPicker value={selectedAgent} onChange={setSelectedAgent} />
            </div>
          )}

          {/* Profile Selection */}
          {!plainShell && (
            <div className="border-t border-[var(--ij-divider-soft)] pt-4">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-text-secondary text-[12px]">Profile</label>
                <button
                  onClick={() => openProfileModal()}
                  className="flex items-center gap-1 text-[11px] text-accent-primary hover:text-accent-secondary transition-colors"
                >
                  <Plus size={12} />
                  Add Profile
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSelectedProfileId(null)}
                  className={`p-2.5 rounded-md text-left transition-colors ${
                    selectedProfileId === null
                      ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                      : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
                  }`}
                >
                  <p className="text-text-primary text-[12px] font-medium">No Profile</p>
                  <p className="text-text-tertiary text-[11px]">Custom settings</p>
                </button>
                {profiles.map((profile) => (
                  <div
                    key={profile.id}
                    className={`relative group rounded-md transition-colors ${
                      selectedProfileId === profile.id
                        ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                        : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
                    }`}
                  >
                    <button
                      onClick={() => setSelectedProfileId(profile.id)}
                      className="w-full p-2.5 pr-8 text-left"
                    >
                      <p className="text-text-primary text-[12px] font-medium truncate">{profile.name}</p>
                      <p className="text-text-tertiary text-[11px] truncate">
                        {profile.description || profile.working_directory || 'No description'}
                      </p>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openProfileModal(profile.id);
                      }}
                      title="Edit profile"
                      className="absolute top-1.5 right-1.5 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Working Directory */}
          <div className="border-t border-[var(--ij-divider-soft)] pt-4">
            <label className="block text-text-secondary text-[12px] mb-1.5">
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
                placeholder={isMac ? "/path/to/project" : "C:\\path\\to\\project"}
              />
              <button
                onClick={handleBrowseDirectory}
                className="px-3 h-9 bg-bg-primary ring-1 ring-border-light rounded-md hover:bg-white/[0.04] transition-colors"
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
                    Worktree of <span className="font-mono text-text-secondary">{worktreeDetect.main_repo_path.replace(/^.*[\\/]/, '')}</span>
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
                          className="w-full bg-bg-secondary ring-1 ring-border-light rounded h-8 px-2.5 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-text-tertiary text-[11px] mb-1">Base branch</label>
                        <div className="relative">
                          <select
                            value={baseBranch}
                            onChange={(e) => setBaseBranch(e.target.value)}
                            className="w-full bg-bg-secondary ring-1 ring-border-light rounded h-8 px-2.5 pr-8 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors appearance-none"
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
                          className="w-full bg-bg-secondary ring-1 ring-border-light rounded h-8 px-2.5 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors"
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

          {/* Claude Arguments */}
          {!plainShell && (
          <div className="border-t border-[var(--ij-divider-soft)] pt-4">
            <label className="block text-text-secondary text-[12px] mb-1.5">
              {specFor(selectedAgent).displayName} Arguments (one per line)
            </label>
            <textarea
              value={claudeArgs.join('\n')}
              onChange={(e) => setClaudeArgs(e.target.value.split('\n').filter(Boolean))}
              className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary font-mono h-20 resize-none transition-colors"
              placeholder={specFor(selectedAgent).defaultArgsHint}
            />
            <p className="text-text-tertiary text-[11px] mt-1">
              Command: <code className="text-text-secondary">{specFor(selectedAgent).binary} {claudeArgs.join(' ')}</code>
            </p>
          </div>
          )}
          {/* Worktree Toggle - Claude-only flag; hidden for other agents */}
          {!plainShell && selectedAgent === 'claude' && (
          <div className="flex items-center justify-between">
            <div>
              <label className="text-text-secondary text-[12px]">Isolated Worktree</label>
              <p className="text-text-tertiary text-[11px]">Run in a separate git worktree</p>
            </div>
            <button
              onClick={() => setUseWorktree(!useWorktree)}
              className={`relative w-9 h-5 rounded-full transition-colors ${
                useWorktree ? 'bg-accent-primary' : 'bg-border-light'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  useWorktree ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          )}

          {/* Model Selector - Claude-only flags; hidden for other agents */}
          {!plainShell && selectedAgent === 'claude' && (
          <div className="border-t border-[var(--ij-divider-soft)] pt-4">
            <label className="block text-text-secondary text-[12px] mb-1.5">Model</label>
            <div className="flex gap-1.5">
              {(['default', 'opus', 'sonnet', 'haiku'] as const).map((model) => (
                <button
                  key={model}
                  onClick={() => setSelectedModel(model)}
                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    selectedModel === model
                      ? model === 'opus' ? 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/30'
                      : model === 'sonnet' ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                      : model === 'haiku' ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30'
                      : 'bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30'
                      : 'bg-bg-primary ring-1 ring-border-light text-text-secondary hover:ring-border'
                  }`}
                >
                  {model === 'default' ? 'Default' : model.charAt(0).toUpperCase() + model.slice(1)}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Effort Selector - Claude-only flag; hidden for other agents */}
          {!plainShell && selectedAgent === 'claude' && (
          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">Effort</label>
            <div className="flex gap-1.5">
              {(['default', 'low', 'medium', 'high'] as const).map((effort) => (
                <button
                  key={effort}
                  onClick={() => setSelectedEffort(effort)}
                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    selectedEffort === effort
                      ? 'bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30'
                      : 'bg-bg-primary ring-1 ring-border-light text-text-secondary hover:ring-border'
                  }`}
                >
                  {effort === 'default' ? 'Default' : effort.charAt(0).toUpperCase() + effort.slice(1)}
                </button>
              ))}
            </div>
          </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20">
              <p className="text-error text-[12px]">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-3 border-t border-[var(--ij-divider-soft)] bg-elevation-2">
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
            {isCreating ? 'Creating...' : (plainShell ? 'Start Shell' : 'Start Terminal')}
          </Button>
        </div>
    </Modal>
  );
}
