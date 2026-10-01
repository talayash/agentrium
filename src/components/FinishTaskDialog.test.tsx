import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { FinishTaskDialog } from './FinishTaskDialog';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import type { TaskInfo, TaskStatus } from '../lib/tasks';

const task: TaskInfo = { title: 'Add search', branch: 'agentrium/add-search', baseBranch: 'main', worktreePath: '/wt/add-search', repoPath: '/repo' };
const config: TerminalConfig = {
  id: 't1', label: 'Add search', nickname: null, profile_id: null, working_directory: task.worktreePath,
  claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', task,
};
let status: TaskStatus;

beforeEach(() => {
  status = { task, exists: true, uncommitted: [], ahead: 2, behind: 0, changed_files: ['src/search.ts'], base_worktree: '/repo', base_dirty: false };
  useTerminalStore.setState({ terminals: new Map([['t1', { config, xterm: null, isWorktree: false }]]) });
  useAppStore.setState({ finishTaskTerminalId: 't1', finishTaskCloseAfter: true, vcsDefaultMergeStrategy: 'merge' });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'get_task_status') return status;
    if (cmd === 'finish_task') return { merged: true, worktree_removed: false, branch_deleted: false, warning: 'locked' };
    return null;
  });
});
afterEach(cleanup);

it('prefills a squash message, merges while the session is open, then closes it and finishes cleanup', async () => {
  render(<FinishTaskDialog />);
  const msg = await screen.findByLabelText('Squash commit message');
  expect((msg as HTMLTextAreaElement).value).toBe('Add search\n\n- src/search.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Squash and finish' }));
  await waitFor(() => expect(useAppStore.getState().finishTaskTerminalId).toBeNull());
  const calls = vi.mocked(invoke).mock.calls.map(([c, a]) => [c, a]);
  const order = calls.map(([c]) => c).filter((c) => c === 'finish_task' || c === 'close_terminal');
  // merge -> close the session (frees the folder on Windows) -> remove worktree + branch
  expect(order).toEqual(['finish_task', 'close_terminal', 'finish_task']);
  expect(calls.find(([c]) => c === 'finish_task')?.[1]).toEqual({
    worktreePath: task.worktreePath, action: { kind: 'merge', mode: 'squash', message: 'Add search\n\n- src/search.ts' },
  });
  expect(calls.filter(([c]) => c === 'finish_task')[1][1]).toEqual({
    worktreePath: task.worktreePath, action: { kind: 'discard', confirm_unmerged: true },
  });
});

it('refuses to merge into a dirty base and says why', async () => {
  status.base_dirty = true;
  render(<FinishTaskDialog />);
  expect(await screen.findByText(/main has uncommitted changes in \/repo/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Squash and finish' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows uncommitted changes and commits them before finishing', async () => {
  status.uncommitted = [{ path: 'src/wip.ts', status: 'M' }];
  render(<FinishTaskDialog />);
  expect(await screen.findByText(/1 uncommitted change/)).toBeTruthy();
  expect(screen.getByText(/Commit the uncommitted changes first/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Commit all' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('commit_task_changes', { worktreePath: task.worktreePath, message: 'Add search' }));
});

it('asks for a second confirmation before discarding unmerged commits', async () => {
  render(<FinishTaskDialog />);
  fireEvent.click(await screen.findByLabelText(/Discard/));
  fireEvent.click(screen.getByRole('button', { name: 'Discard task' }));
  expect(await screen.findByText(/2 commit\(s\) that are not in main/)).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'finish_task')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard 2 commit(s)' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('finish_task', {
    worktreePath: task.worktreePath, action: { kind: 'discard', confirm_unmerged: true },
  }));
  const order = vi.mocked(invoke).mock.calls.map(([c]) => c).filter((c) => c === 'finish_task' || c === 'close_terminal');
  expect(order).toEqual(['close_terminal', 'finish_task']);
});

it('can close the session and keep the worktree', async () => {
  render(<FinishTaskDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'Close session, keep worktree' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_terminal', { id: 't1' }));
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'finish_task')).toBe(false);
});
