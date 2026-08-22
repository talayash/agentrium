import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorktreeCloseModal } from './WorktreeCloseModal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

const row = {
  terminal_id: 't1',
  worktree_path: '/repo-feat',
  base_branch: 'main',
  branch_name: 'feat/x',
  created_at: 0,
};

function mockDefaults() {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_worktree_info') return {
      is_git_repo: true, is_worktree: true, main_repo_path: '/repo',
      current_branch: 'feat/x', worktree_root: '/repo-feat',
      dirty_count: 0, ahead: 3, behind: 0,
    };
    if (cmd === 'git_log_since_base') return ['add auth', 'fix login'];
    if (cmd === 'get_profiles') return [
      { id: 'p1', name: 'Backend', description: null, working_directory: '', claude_args: [], env_vars: {}, is_default: true },
    ];
    return undefined;
  });
}

describe('WorktreeCloseModal', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockDefaults();
  });

  it('renders summary line', async () => {
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/3 commits ahead of main/)).toBeInTheDocument());
  });

  it('Merge button calls merge_worktree_ff', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('merge_worktree_ff', expect.objectContaining({
        terminalId: 't1', worktreePath: '/repo-feat', baseBranch: 'main',
      }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Squash reveals textarea with auto-generated message', async () => {
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Squash-merge/ }));
    const ta = await screen.findByRole('textbox');
    expect((ta as HTMLTextAreaElement).value).toContain('feat/x');
    expect((ta as HTMLTextAreaElement).value).toContain('- add auth');
    expect((ta as HTMLTextAreaElement).value).toContain('- fix login');
  });

  it('Discard button calls discard_worktree', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Discard branch/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('discard_worktree', expect.objectContaining({
        terminalId: 't1', worktreePath: '/repo-feat',
      }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Keep button closes without invoking a lifecycle command', async () => {
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Keep worktree/ }));
    expect(onClose).toHaveBeenCalled();
    const lifecycleCalls = invokeMock.mock.calls.filter(([c]) =>
      c === 'merge_worktree_ff' || c === 'squash_merge_worktree' || c === 'discard_worktree'
    );
    expect(lifecycleCalls).toEqual([]);
  });

  it('backend error keeps modal open with error text', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_worktree_info') return {
        is_git_repo: true, is_worktree: true, main_repo_path: '/repo',
        current_branch: 'feat/x', worktree_root: '/repo-feat',
        dirty_count: 0, ahead: 3, behind: 0,
      };
      if (cmd === 'merge_worktree_ff') throw 'Merge failed: base has moved.';
      return undefined;
    });
    const onClose = vi.fn();
    render(<WorktreeCloseModal open row={row} profileName="Backend" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/ }));
    await waitFor(() => expect(screen.getByText(/Merge failed/)).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
