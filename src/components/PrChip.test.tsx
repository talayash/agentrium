import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { PrChip } from './PrChip';
import { prKey, type PullRequestStatus } from '../lib/pullRequests';
import { useAppStore } from '../store/appStore';
import { useCiRepairStore } from '../store/ciRepairStore';
import { usePrStore } from '../store/prStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

const key = prKey('/src/app', 'feat/login');
const config: TerminalConfig = {
  id: 's1', label: 'Login', nickname: null, profile_id: null, working_directory: '/src/app', claude_args: [],
  env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [],
};
const status = (ci: PullRequestStatus['ci']['state']): PullRequestStatus => ({
  number: 12, url: 'https://github.com/o/r/pull/12', provider: 'github', state: 'open', draft: false,
  review_decision: null, mergeable: null, ci: { state: ci, total: 1, failing: ci === 'failure' ? [{ name: 'test', url: null }] : [] },
});
const worktree = '/src/.agentrium-worktrees/app/fix-ci-on-12';

beforeEach(() => {
  useTerminalStore.setState({
    terminals: new Map([['s1', { config, xterm: null, isWorktree: false }]]),
    activeTerminalId: 's1',
    gitInfoCache: new Map([['s1', { is_git_repo: true, current_branch: 'feat/login', worktree_root: '/src/app', is_worktree: false } as never]]),
  });
  usePrStore.setState({
    refs: { [key]: { url: 'https://github.com/o/r/pull/12', number: 12, provider: 'github', updatedAt: 0 } },
    statuses: { [key]: status('failure') },
  });
  useCiRepairStore.setState({ repairs: {} });
  useAppStore.setState({ ciRepairTerminalId: null });
});
afterEach(cleanup);

it('offers "Fix with agent" on failing CI and opens the review dialog', () => {
  render(<PrChip terminalId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }));
  expect(useAppStore.getState().ciRepairTerminalId).toBe('s1');
});

it('adds nothing to the compact chip or to a passing PR', () => {
  const { unmount } = render(<PrChip terminalId="s1" compact />);
  expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
  unmount();
  usePrStore.setState({ statuses: { [key]: status('success') } });
  render(<PrChip terminalId="s1" />);
  expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
});

it('shows a running repair instead, and jumps to its session', () => {
  const task = { title: 'Fix CI on #12', branch: 'agentrium/fix-ci-on-12', baseBranch: 'feat/login', worktreePath: worktree, repoPath: '/src/app' };
  useTerminalStore.setState((s) => ({
    terminals: new Map([...s.terminals, ['r1', { config: { ...config, id: 'r1', working_directory: worktree, task }, xterm: null, isWorktree: true }]]),
  }));
  useCiRepairStore.getState().addRepair({ prKey: key, prNumber: 12, prUrl: 'u', branch: 'feat/login', worktreePath: worktree });
  render(<PrChip terminalId="s1" />);
  expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open CI repair session' }));
  expect(useTerminalStore.getState().activeTerminalId).toBe('r1');
});
