import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { BACKGROUND_INTERVAL_MS, VISIBLE_INTERVAL_MS, pollPullRequests, type PollOptions } from './usePullRequestPoller';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { usePrStore } from '../store/prStore';
import { useAttentionStore } from '../store/attentionStore';
import { prKey, type PullRequestStatus } from '../lib/pullRequests';
import type { WorktreeDetectResult } from '../types/git';

const KEY = prKey('/repo', 'feat/x');
const config = (id: string): TerminalConfig => ({
  id, label: `Session ${id}`, nickname: null, profile_id: null, working_directory: '/repo', claude_args: [],
  env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude',
});
const git: WorktreeDetectResult = {
  is_git_repo: true, is_worktree: false, main_repo_path: null, current_branch: 'feat/x', worktree_root: '/repo',
  dirty_count: 0, ahead: 0, behind: 0,
};
const status = (state: PullRequestStatus['state'], ci: PullRequestStatus['ci']['state'], failing: string[] = []): PullRequestStatus => ({
  number: 12, url: 'https://github.com/o/r/pull/12', provider: 'github', state, draft: false, review_decision: null,
  mergeable: 'mergeable', ci: { state: ci, total: 2, failing: failing.map(name => ({ name, url: null })) },
});

let opts: PollOptions;
let next: PullRequestStatus | null;

beforeEach(() => {
  useTerminalStore.setState({
    terminals: new Map([['t1', { config: config('t1'), xterm: null, isWorktree: false }], ['t2', { config: config('t2'), xterm: null, isWorktree: false }]]),
    gitInfoCache: new Map([['t1', git], ['t2', git]]),
    activeTerminalId: 't2',
  });
  useAppStore.setState({ gridMode: false, splitMode: false, splitTerminalIds: null, dndEnabled: false, notificationSoundEnabled: false });
  usePrStore.setState({ refs: { [KEY]: { url: 'https://github.com/o/r/pull/12', number: 12, provider: 'github', lastState: 'open', lastCi: 'pending', updatedAt: 0 } }, statuses: {} });
  useAttentionStore.setState({ items: [] });
  next = status('open', 'success');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'get_pull_request_status' ? next : null));
  opts = { focused: false, now: 1_000_000, lastPolled: new Map(), inFlight: new Set(), notify: vi.fn() };
});

describe('pollPullRequests', () => {
  it('asks once per branch, not once per tab, and stores the status', async () => {
    await pollPullRequests(opts);
    const calls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'get_pull_request_status');
    expect(calls).toEqual([['get_pull_request_status', { path: '/repo', branch: 'feat/x' }]]);
    expect(usePrStore.getState().statuses[KEY].ci.state).toBe('success');
    expect(usePrStore.getState().refs[KEY]).toMatchObject({ lastState: 'open', lastCi: 'success' });
    expect(useAttentionStore.getState().items).toEqual([]);
  });

  it('puts a CI-failing item on the visible tab and notifies', async () => {
    next = status('open', 'failure', ['lint', 'test']);
    await pollPullRequests(opts);
    const items = useAttentionStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ terminalId: 't2', kind: 'ci', url: 'https://github.com/o/r/pull/12', detail: 'Failing: lint, test.' });
    expect(opts.notify).toHaveBeenCalledWith('CI failing on PR #12', 'Session t2: Failing: lint, test.');

    // Still failing on the next poll: no second item, no second notification.
    useAttentionStore.setState({ items: [] });
    await pollPullRequests({ ...opts, now: opts.now + BACKGROUND_INTERVAL_MS });
    expect(useAttentionStore.getState().items).toEqual([]);
    expect(opts.notify).toHaveBeenCalledTimes(1);
  });

  it('survives the agent going busy: session dismissals leave the PR item', async () => {
    next = status('open', 'failure', ['lint']);
    await pollPullRequests(opts);
    useAttentionStore.getState().put({ terminalId: 't2', targetId: 't2', kind: 'input', title: 'x', detail: 'y' });
    useAttentionStore.getState().dismiss('t2');
    expect(useAttentionStore.getState().items.map(i => i.kind)).toEqual(['ci']);
  });

  it('reports a merge but does not notify the tab the user is looking at', async () => {
    next = status('merged', 'success');
    await pollPullRequests({ ...opts, focused: true });
    expect(useAttentionStore.getState().items[0]).toMatchObject({ kind: 'merged', terminalId: 't2' });
    expect(opts.notify).not.toHaveBeenCalled();
  });

  it('treats a PR with no recorded state as a baseline', async () => {
    usePrStore.getState().setRef(KEY, { url: 'u', number: 12, provider: 'github' });
    next = status('open', 'failure', ['lint']);
    await pollPullRequests(opts);
    expect(useAttentionStore.getState().items).toEqual([]);
    expect(usePrStore.getState().refs[KEY].lastCi).toBe('failure');
  });

  it('respects Do Not Disturb for the notification but still fills the inbox', async () => {
    useAppStore.setState({ dndEnabled: true, dndStart: '00:00', dndEnd: '23:59' });
    next = status('open', 'failure', ['lint']);
    await pollPullRequests({ ...opts, now: new Date(2026, 9, 1, 12, 0).getTime() });
    expect(useAttentionStore.getState().items).toHaveLength(1);
    expect(opts.notify).not.toHaveBeenCalled();
  });

  it('polls visible tabs every minute and backs off when unfocused', async () => {
    const focused = { ...opts, focused: true };
    await pollPullRequests(focused);
    await pollPullRequests({ ...focused, now: focused.now + VISIBLE_INTERVAL_MS - 1 });
    await pollPullRequests({ ...focused, now: focused.now + VISIBLE_INTERVAL_MS });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    // Unfocused: the same minute later is too soon.
    await pollPullRequests({ ...opts, now: focused.now + 2 * VISIBLE_INTERVAL_MS });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    await pollPullRequests({ ...opts, now: focused.now + VISIBLE_INTERVAL_MS + BACKGROUND_INTERVAL_MS });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
  });

  it('swallows a failed poll and keeps the last known state', async () => {
    vi.mocked(invoke).mockRejectedValue('offline');
    await expect(pollPullRequests(opts)).resolves.toBeUndefined();
    expect(usePrStore.getState().refs[KEY].lastCi).toBe('pending');
    expect(useAttentionStore.getState().items).toEqual([]);
  });

  it('rebaselines when a newer PR heads the branch', async () => {
    next = { ...status('open', 'failure', ['lint']), number: 13, url: 'https://github.com/o/r/pull/13' };
    await pollPullRequests(opts);
    expect(useAttentionStore.getState().items).toEqual([]);
    expect(usePrStore.getState().refs[KEY]).toMatchObject({ number: 13, url: 'https://github.com/o/r/pull/13' });
  });

  it('skips branches without a tracked PR', async () => {
    usePrStore.setState({ refs: {}, statuses: {} });
    await pollPullRequests(opts);
    expect(invoke).not.toHaveBeenCalled();
  });
});
