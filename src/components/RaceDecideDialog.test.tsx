import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { RaceDecideDialog } from './RaceDecideDialog';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import type { TaskStatus } from '../lib/tasks';
import type { Race, RaceContender } from '../lib/races';

const contender = (idx: number, agent: 'claude' | 'codex', label: string): RaceContender => ({
  idx, agent, model: null, args: [], label, branch: `agentrium/race-fix-${agent}`, worktreePath: `/wt/race-fix-${agent}`,
  terminalId: null, startedAt: null, finishedAt: null, outcome: 'pending', stats: null,
});
const race: Race = {
  id: 'r1', title: 'Fix bug', prompt: 'p', repoPath: '/repo', baseBranch: 'main', baseSha: 'abc', createdAt: '',
  status: 'judging', winnerTask: null, decidedAt: null, checkCommand: null,
  contenders: [contender(0, 'claude', 'Claude Code'), contender(1, 'codex', 'Codex')],
};
const terminalConfig = (id: string, c: RaceContender): TerminalConfig => ({
  id, label: id, nickname: null, profile_id: null, working_directory: c.worktreePath, claude_args: [], env_vars: {},
  created_at: '', status: 'Running', color_tag: null, agent: c.agent,
  task: { title: 'Fix bug', branch: c.branch, baseBranch: 'main', worktreePath: c.worktreePath, repoPath: '/repo', raceId: 'r1' },
});
let statuses: Record<string, TaskStatus>;

beforeEach(() => {
  statuses = Object.fromEntries(race.contenders.map((c, i) => [c.worktreePath, {
    task: { title: 'Fix bug', branch: c.branch, baseBranch: 'main', worktreePath: c.worktreePath, repoPath: '/repo' },
    exists: true, uncommitted: [], ahead: i === 0 ? 2 : 1, behind: 0, changed_files: ['src/a.ts'],
    base_worktree: '/repo', base_dirty: false,
  }]));
  useRaceStore.setState({ races: { r1: race }, checks: {}, diffs: {} });
  useTerminalStore.setState({ terminals: new Map([
    ['t0', { config: terminalConfig('t0', race.contenders[0]), xterm: null, isWorktree: false }],
    ['t1', { config: terminalConfig('t1', race.contenders[1]), xterm: null, isWorktree: false }],
  ]) });
  useAppStore.setState({ decideRaceId: 'r1', decideRaceMode: 'decide', vcsDefaultMergeStrategy: 'merge', createPrModalOpen: false, gridMode: true, gridTerminalIds: ['t0', 't1'] });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_task_status') return statuses[(args as { worktreePath: string }).worktreePath];
    if (cmd === 'decide_race') return {
      winner: { merged: true, worktree_removed: false, branch_deleted: false, warning: 'locked' },
      losers: [{ worktree_path: '/wt/race-fix-codex', result: { merged: false, worktree_removed: true, branch_deleted: true, warning: null }, error: null }],
    };
    if (cmd === 'get_race') return { ...race, status: 'decided' };
    return null;
  });
});
afterEach(cleanup);

it('needs confirmation to discard a loser\'s unmerged commits and running session, then merges and cleans up in order', async () => {
  render(<RaceDecideDialog />);
  expect(await screen.findByText(/Squash-merge agentrium\/race-fix-claude into main/)).toBeTruthy();
  const merge = screen.getByRole('button', { name: 'Merge winner' }) as HTMLButtonElement;
  expect(merge.disabled).toBe(true);

  fireEvent.click(screen.getByLabelText('Discard 1 unmerged commit(s)'));
  expect(merge.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Close 1 session\(s\) that are still running \(Codex\)/));
  expect(merge.disabled).toBe(false);
  fireEvent.click(merge);

  await waitFor(() => expect(useAppStore.getState().decideRaceId).toBeNull());
  const calls = vi.mocked(invoke).mock.calls;
  const order = calls.map(([c, a]) => (c === 'close_terminal' ? `close:${(a as { id: string }).id}` : c))
    .filter((c) => c.startsWith('close:') || c === 'decide_race' || c === 'finish_task');
  // Every session closes before git touches the worktrees (a live agent
  // holds its folder on Windows); a leftover winner worktree is removed after.
  expect(order).toEqual(['close:t1', 'close:t0', 'decide_race', 'finish_task']);
  const request = (calls.find(([c]) => c === 'decide_race')![1] as { request: Record<string, unknown> }).request;
  expect(request).toMatchObject({
    race_id: 'r1', winner_worktree: '/wt/race-fix-claude',
    winner_action: { kind: 'merge', mode: 'squash', message: 'Fix bug\n\n- src/a.ts' },
    losers: [{ worktree_path: '/wt/race-fix-codex', keep_branch: false, confirm_unmerged: true }],
  });
  expect(Object.keys(request.stats as object)).toEqual(['/wt/race-fix-claude', '/wt/race-fix-codex']);
  // Both sessions closed: the race grid is cleared and grid mode ends.
  expect(useAppStore.getState().gridTerminalIds).toEqual([]);
  expect(useAppStore.getState().gridMode).toBe(false);
});

it('keeps the winner for a pull request with a "Raced against" body', async () => {
  render(<RaceDecideDialog />);
  await screen.findByText(/Squash-merge/);
  fireEvent.click(screen.getByLabelText(/Keep the branch and create a pull request/));
  fireEvent.click(screen.getByLabelText('Keep branch'));
  fireEvent.click(screen.getByLabelText(/still running/));
  fireEvent.click(screen.getByRole('button', { name: 'Keep winner and create PR' }));
  await waitFor(() => expect(useAppStore.getState().createPrModalOpen).toBe(true));
  const s = useAppStore.getState();
  expect(s.createPrRepoPath).toBe('/wt/race-fix-claude');
  expect(s.createPrTerminalId).toBe('t0');
  expect(s.createPrExtraBody).toContain('### Raced against');
  const request = (vi.mocked(invoke).mock.calls.find(([c]) => c === 'decide_race')![1] as { request: Record<string, unknown> }).request;
  expect(request).toMatchObject({ winner_action: { kind: 'pull-request' }, losers: [{ keep_branch: true, confirm_unmerged: false }] });
  // The PR winner's session stays open.
  expect(vi.mocked(invoke).mock.calls.some(([c, a]) => c === 'close_terminal' && (a as { id: string }).id === 't0')).toBe(false);
});

it('re-checks the winner right before merging and closes nothing if it changed', async () => {
  render(<RaceDecideDialog />);
  await screen.findByText(/Squash-merge/);
  fireEvent.click(screen.getByLabelText('Discard 1 unmerged commit(s)'));
  fireEvent.click(screen.getByLabelText(/still running/));
  // The agent writes a file after the dialog loaded.
  statuses['/wt/race-fix-claude'].uncommitted = [{ path: 'late.ts', status: '??' }];
  fireEvent.click(screen.getByRole('button', { name: 'Merge winner' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  const calls = vi.mocked(invoke).mock.calls.map(([c]) => c);
  expect(calls).not.toContain('decide_race');
  expect(calls).not.toContain('close_terminal');
});

it('blocks a winner with uncommitted changes until they are committed', async () => {
  statuses['/wt/race-fix-claude'].uncommitted = [{ path: 'src/wip.ts', status: 'M' }];
  render(<RaceDecideDialog />);
  expect(await screen.findByText('The winner has uncommitted changes. Commit them first.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Commit first' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('commit_task_changes', { worktreePath: '/wt/race-fix-claude', message: 'Fix bug (Claude Code)' }));
});

it('abandon discards every contender after confirming running sessions', async () => {
  useAppStore.setState({ decideRaceMode: 'abandon' });
  useAppStore.getState().openRaceTab('r1', 'Fix bug');
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_task_status') return { ...statuses[(args as { worktreePath: string }).worktreePath], ahead: 0 };
    if (cmd === 'abandon_race') return [];
    if (cmd === 'get_race') return { ...race, status: 'abandoned' };
    return null;
  });
  render(<RaceDecideDialog />);
  const btn = await screen.findByRole('button', { name: 'Abandon race' }) as HTMLButtonElement;
  await screen.findByText(/Claude Code: delete the worktree/);
  expect(btn.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Close 2 session\(s\)/));
  fireEvent.click(btn);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('abandon_race', expect.objectContaining({ request: expect.objectContaining({
    race_id: 'r1',
    contenders: [
      { worktree_path: '/wt/race-fix-claude', keep_branch: false, confirm_unmerged: false, confirm_uncommitted: false },
      { worktree_path: '/wt/race-fix-codex', keep_branch: false, confirm_unmerged: false, confirm_uncommitted: false },
    ],
  }) })));
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'close_terminal')).toHaveLength(2);
  // Nothing left to compare: the race tab closes too.
  await waitFor(() => expect(useAppStore.getState().openFiles.some((t) => t.path === 'race:r1')).toBe(false));
});

it('runs one decision even when the confirm button is clicked twice', async () => {
  render(<RaceDecideDialog />);
  await screen.findByText(/Squash-merge/);
  fireEvent.click(screen.getByLabelText('Discard 1 unmerged commit(s)'));
  fireEvent.click(screen.getByLabelText(/still running/));
  const merge = screen.getByRole('button', { name: 'Merge winner' });
  fireEvent.click(merge);
  fireEvent.click(merge);
  await waitFor(() => expect(useAppStore.getState().decideRaceId).toBeNull());
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'decide_race')).toHaveLength(1);
});
