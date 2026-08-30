import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GitBranch, GitFork, Plus, Trash2, Terminal, Loader2, ChevronDown, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { WorktreeInfo } from '../types/git';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';

export function WorktreeModal() {
  const { closeWorktreeModal, worktreeModalRepoPath, defaultClaudeArgs } = useAppStore();
  const { terminals, createTerminal } = useTerminalStore();

  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New worktree form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [newWorktreePath, setNewWorktreePath] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Remove state
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Opening terminal
  const [openingTerminal, setOpeningTerminal] = useState(false);

  // Worktree status
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);

  const repoPath = worktreeModalRepoPath || '';
  const repoName = repoPath.replace(/^.*[\\/]/, '');

  useEffect(() => {
    if (repoPath) loadWorktrees();
  }, [repoPath]);

  useEffect(() => {
    if (selectedPath) fetchStatus(selectedPath);
  }, [selectedPath]);

  // Auto-generate worktree path
  useEffect(() => {
    if (newBranchName && repoPath) {
      const parentDir = repoPath.replace(/[\\/][^\\/]*$/, '');
      const sanitized = newBranchName.replace(/\//g, '-');
      // Match the repo path's separator so the prefilled path is valid on
      // macOS/Linux too (hardcoding '\\' produced broken paths there).
      const sep = repoPath.includes('\\') ? '\\' : '/';
      setNewWorktreePath(`${parentDir}${sep}${repoName}-${sanitized}`);
    }
  }, [newBranchName, repoPath, repoName]);

  const loadWorktrees = async () => {
    setLoading(true);
    setError(null);
    try {
      const [wts, brs] = await Promise.all([
        invoke<WorktreeInfo[]>('list_worktrees', { path: repoPath }),
        invoke<string[]>('get_repo_branches', { path: repoPath }),
      ]);
      setWorktrees(wts);
      setBranches(brs);
      if (brs.length > 0) setBaseBranch(brs[0]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchStatus = async (path: string) => {
    const wt = worktrees.find(w => w.path === path);
    if (wt) {
      setSelectedStatus(wt.is_detached ? 'Detached HEAD' : `HEAD: ${wt.head_sha}`);
    } else {
      setSelectedStatus(null);
    }
  };

  const handleCreateWorktree = async () => {
    if (!newBranchName.trim() || !newWorktreePath.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const branchExists = branches.includes(newBranchName);
      await invoke<WorktreeInfo>('create_worktree', {
        repoPath,
        worktreePath: newWorktreePath,
        branch: newBranchName,
        createBranch: !branchExists,
      });
      setShowNewForm(false);
      setNewBranchName('');
      await loadWorktrees();
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveWorktree = async (force: boolean) => {
    if (!selectedPath) return;
    const selected = worktrees.find(w => w.path === selectedPath);
    if (!selected || selected.is_main) return;

    setRemoving(true);
    setRemoveError(null);
    try {
      await invoke('remove_worktree', {
        repoPath,
        worktreePath: selectedPath,
        force,
      });
      setSelectedPath(null);
      setConfirmRemove(false);
      await loadWorktrees();
    } catch (err) {
      const errStr = String(err);
      if (!force && (errStr.includes('untracked') || errStr.includes('modified') || errStr.includes('changes'))) {
        setRemoveError(errStr);
        setConfirmRemove(true);
      } else {
        setRemoveError(errStr);
      }
    } finally {
      setRemoving(false);
    }
  };

  const handleOpenTerminal = async () => {
    if (!selectedPath) return;
    setOpeningTerminal(true);
    try {
      const selected = worktrees.find(w => w.path === selectedPath);
      const label = `Terminal ${terminals.size + 1}`;
      const TAG_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-blue-500', 'bg-purple-500', 'bg-pink-500'];
      const colorTag = TAG_COLORS[terminals.size % TAG_COLORS.length];
      const nickname = selected?.branch ? `${repoName} (${selected.branch})` : undefined;

      await createTerminal(label, selectedPath, defaultClaudeArgs, {}, colorTag, nickname);
      closeWorktreeModal();
    } catch (err) {
      reportInvokeFailure('create_terminal_from_worktree', err);
    } finally {
      setOpeningTerminal(false);
    }
  };

  const selectedWorktree = worktrees.find(w => w.path === selectedPath);

  return (
    <Modal
      onClose={closeWorktreeModal}
      closeOn="doubleClick"
      panelClassName="w-full max-w-3xl"
      scrimClassName="bg-black/60 z-50"
      showHeader
      icon={<GitFork size={16} className="text-purple-400" />}
      title={
        <>
          Worktrees
          {repoName && <span className="text-text-tertiary font-normal"> - {repoName}</span>}
        </>
      }
    >
        {/* Content */}
        <div className="flex h-[400px]">
          {/* Left: Worktree List */}
          <div className="w-64 border-r border-border p-3 flex flex-col">
            {/* Worktree List */}
            <div className="flex-1 overflow-y-auto space-y-0.5">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={16} className="text-text-tertiary animate-spin" />
                </div>
              ) : error ? (
                <p className="text-error text-[12px] text-center py-4">{error}</p>
              ) : worktrees.length === 0 ? (
                <EmptyState
                  icon={<GitBranch size={20} strokeWidth={1.75} />}
                  title="No worktrees"
                  description="Create a worktree to work on multiple branches in parallel."
                  compact
                />
              ) : (
                worktrees.map((wt) => (
                  <ListRow
                    key={wt.path}
                    selected={selectedPath === wt.path}
                    onClick={() => {
                      setSelectedPath(wt.path);
                      setConfirmRemove(false);
                      setRemoveError(null);
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
                    <div className="flex flex-col min-w-0">
                      <span className="text-text-primary text-[12px] font-mono font-medium truncate">
                        {wt.branch || '(detached)'}
                      </span>
                      {wt.is_main && (
                        <span className="text-text-tertiary text-[11px]">main worktree</span>
                      )}
                    </div>
                  </ListRow>
                ))
              )}
            </div>

            {/* New Worktree Button */}
            <button
              onClick={() => {
                setShowNewForm(!showNewForm);
                setCreateError(null);
              }}
              className="mt-2 w-full flex items-center justify-center gap-1.5 text-accent-primary hover:bg-accent-primary/10 py-2 rounded-md text-[12px] font-medium transition-colors"
            >
              <Plus size={14} />
              New Worktree
            </button>
          </div>

          {/* Right: Details or New Form */}
          <div className="flex-1 p-4 flex flex-col">
            <AnimatePresence mode="wait">
              {showNewForm ? (
                <motion.div
                  key="new-form"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="flex-1 flex flex-col"
                >
                  <h3 className="text-text-primary text-[13px] font-semibold mb-3">Create New Worktree</h3>
                  <div className="space-y-3 flex-1">
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-1">Branch name</label>
                      <input
                        type="text"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        placeholder="feature/my-branch"
                        className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-1">Base branch</label>
                      <div className="relative">
                        <select
                          value={baseBranch}
                          onChange={(e) => setBaseBranch(e.target.value)}
                          className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 pr-8 text-text-primary text-[13px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors appearance-none"
                        >
                          {branches.map(b => (
                            <option key={b} value={b}>{b}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-1">Worktree path</label>
                      <input
                        type="text"
                        value={newWorktreePath}
                        onChange={(e) => setNewWorktreePath(e.target.value)}
                        dir="ltr"
                        className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                      />
                      <p className="text-text-tertiary text-[11px] mt-1">Auto-generated from branch name</p>
                    </div>
                    {createError && (
                      <div className="p-2 rounded-md bg-error/5 ring-1 ring-error/20">
                        <p className="text-error text-[12px]">{createError}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 pt-4 border-t border-border">
                    <Button
                      variant="primary"
                      onClick={handleCreateWorktree}
                      disabled={!newBranchName.trim()}
                      loading={creating}
                      icon={<Plus size={14} />}
                    >
                      {creating ? 'Creating...' : 'Create Worktree'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setShowNewForm(false);
                        setCreateError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </motion.div>
              ) : selectedWorktree ? (
                <motion.div
                  key={`detail-${selectedPath}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="flex-1 flex flex-col"
                >
                  <div className="flex-1 space-y-3">
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-0.5">Branch</label>
                      <div className="flex items-center gap-2">
                        {selectedWorktree.is_main ? (
                          <GitBranch size={16} className="text-accent-primary" />
                        ) : (
                          <GitFork size={16} className="text-purple-400" />
                        )}
                        <p className="text-text-primary text-[14px] font-mono font-medium">
                          {selectedWorktree.branch || '(detached HEAD)'}
                        </p>
                        {selectedWorktree.is_main && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary">main</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-0.5">Path</label>
                      <p className="text-text-primary text-[13px] break-all" dir="ltr">{selectedWorktree.path}</p>
                    </div>
                    <div>
                      <label className="block text-text-tertiary text-[11px] mb-0.5">HEAD</label>
                      <p className="text-text-secondary text-[13px] font-mono">{selectedWorktree.head_sha}</p>
                    </div>
                    {selectedStatus && (
                      <div>
                        <label className="block text-text-tertiary text-[11px] mb-0.5">Status</label>
                        <p className="text-text-secondary text-[13px]">{selectedStatus}</p>
                      </div>
                    )}

                    {removeError && (
                      <div className="p-2.5 rounded-md bg-error/5 ring-1 ring-error/20">
                        <p className="text-error text-[12px]">{removeError}</p>
                        {confirmRemove && (
                          <Button
                            variant="danger"
                            size="sm"
                            className="mt-2"
                            onClick={() => handleRemoveWorktree(true)}
                            loading={removing}
                            icon={<AlertTriangle size={12} />}
                          >
                            {removing ? 'Removing...' : 'Force Remove'}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 pt-4 border-t border-border">
                    <Button
                      variant="primary"
                      onClick={handleOpenTerminal}
                      loading={openingTerminal}
                      icon={<Terminal size={14} />}
                    >
                      {openingTerminal ? 'Opening...' : 'Open Terminal'}
                    </Button>
                    {!selectedWorktree.is_main && (
                      <Button
                        variant="danger"
                        onClick={() => handleRemoveWorktree(false)}
                        loading={removing}
                        icon={<Trash2 size={14} />}
                      >
                        {removing ? 'Removing...' : 'Remove'}
                      </Button>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="h-full flex items-center justify-center text-text-tertiary text-[13px]"
                >
                  Select a worktree or create a new one
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
    </Modal>
  );
}
