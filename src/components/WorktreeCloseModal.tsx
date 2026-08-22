import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { AppWorktreeRow, WorktreeCloseAction } from '../types/git';

interface WorktreeDetectResult {
  is_git_repo: boolean;
  is_worktree: boolean;
  main_repo_path: string | null;
  current_branch: string | null;
  worktree_root: string | null;
  dirty_count: number | null;
  ahead: number | null;
  behind: number | null;
}

interface Props {
  open: boolean;
  row: AppWorktreeRow;
  profileName: string | null;
  onClose: () => void;
}

export function WorktreeCloseModal({ open, row, profileName, onClose }: Props) {
  const [info, setInfo] = useState<WorktreeDetectResult | null>(null);
  const [mode, setMode] = useState<'menu' | 'squash'>('menu');
  const [squashMessage, setSquashMessage] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    if (!open) return;
    invoke<WorktreeDetectResult>('get_worktree_info', { path: row.worktree_path })
      .then(setInfo)
      .catch((e) => reportInvokeFailure('get_worktree_info', e));
  }, [open, row.worktree_path]);

  const saveProfileDefault = async (action: WorktreeCloseAction) => {
    if (!remember || !profileName) return;
    try {
      const profiles = await invoke<any[]>('get_profiles');
      const p = profiles.find((x) => x.name === profileName);
      if (!p) return;
      await invoke('save_profile', { profile: { ...p, worktree_close_default: action } });
    } catch (e) {
      reportInvokeFailure('save_profile', e);
    }
  };

  const doMerge = async () => {
    setInFlight(true); setError(null);
    try {
      await invoke('merge_worktree_ff', {
        terminalId: row.terminal_id,
        worktreePath: row.worktree_path,
        baseBranch: row.base_branch,
      });
      await saveProfileDefault('merge');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  const openSquash = async () => {
    setMode('squash'); setError(null);
    try {
      const subjects = await invoke<string[]>('git_log_since_base', {
        worktreePath: row.worktree_path,
        baseBranch: row.base_branch,
      });
      const body = subjects.map((s) => `- ${s}`).join('\n');
      setSquashMessage(`${row.branch_name}\n\n${body}`);
    } catch (e) {
      reportInvokeFailure('git_log_since_base', e);
      setSquashMessage(row.branch_name);
    }
  };

  const doSquash = async () => {
    if (!squashMessage.trim()) { setError('Message cannot be empty.'); return; }
    setInFlight(true); setError(null);
    try {
      await invoke('squash_merge_worktree', {
        terminalId: row.terminal_id,
        worktreePath: row.worktree_path,
        baseBranch: row.base_branch,
        message: squashMessage,
      });
      await saveProfileDefault('squash');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  const doKeep = () => {
    // Fire-and-forget profile preference save; keep is a no-op lifecycle action.
    saveProfileDefault('keep').catch(() => {});
    onClose();
  };

  const doDiscard = async () => {
    setInFlight(true); setError(null);
    try {
      await invoke('discard_worktree', {
        terminalId: row.terminal_id,
        worktreePath: row.worktree_path,
      });
      await saveProfileDefault('discard');
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setInFlight(false);
    }
  };

  if (!open) return null;

  const summary = info
    ? `${info.ahead ?? 0} commits ahead of ${row.base_branch} · ${info.dirty_count ?? 0} uncommitted changes`
    : 'Loading...';

  return (
    <Modal
      onClose={onClose}
      closeOn="none"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-[400px] max-h-[80vh] flex flex-col"
      showHeader
      title={`Session done on ${row.branch_name}`}
      icon={<Info size={16} className="text-accent-primary" />}
    >
      <div className="p-4 space-y-3">
        <p className="text-text-secondary text-[12px]">{summary}</p>

        {mode === 'menu' && (
          <div className="flex flex-col gap-2">
            <Button variant="primary" onClick={doMerge} loading={inFlight}>
              Merge to {row.base_branch}, then delete worktree
            </Button>
            <Button variant="secondary" onClick={openSquash}>
              Squash-merge, tidy commit, then delete
            </Button>
            <Button variant="ghost" onClick={doKeep}>
              Keep worktree, I'll deal with it
            </Button>
            <Button variant="danger" onClick={doDiscard} loading={inFlight}>
              Discard branch + delete worktree
            </Button>
          </div>
        )}

        {mode === 'squash' && (
          <div className="flex flex-col gap-2">
            <label className="text-text-secondary text-[11px]">Commit message</label>
            <textarea
              value={squashMessage}
              onChange={(e) => setSquashMessage(e.target.value)}
              rows={6}
              className="w-full bg-bg-primary ring-1 ring-border-light rounded-md p-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>Back</Button>
              <Button variant="primary" onClick={doSquash} loading={inFlight}>
                Confirm squash-merge
              </Button>
            </div>
          </div>
        )}

        {profileName && (
          <label className="flex items-center gap-2 text-text-secondary text-[11px] pt-2 border-t border-[var(--ij-divider-soft)]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              aria-label="Remember for profile"
            />
            Remember for the "{profileName}" profile
          </label>
        )}

        {error && (
          <div className="p-2 rounded-md bg-error/5 ring-1 ring-error/20">
            <p className="text-error text-[12px]">{error}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
