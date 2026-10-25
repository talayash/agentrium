import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { subscribeTaskReview } from './useTaskReviewPoller';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { useTaskObservationStore } from '../store/taskObservationStore';
import type { TaskStatus } from '../lib/tasks';

const task = { title: 'Fix login', branch: 'agentrium/fix-login', baseBranch: 'main', worktreePath: '/wt/fix', repoPath: '/repo' };
const config: TerminalConfig = { id: 't', label: 'Fix login', nickname: null, profile_id: null, working_directory: '/wt/fix',
  claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', task };

let current: TaskStatus;
const status = (patch: Partial<TaskStatus> = {}): TaskStatus => ({
  task, exists: true, uncommitted: [], ahead: 1, behind: 0, changed_files: ['a.ts'], base_worktree: '/repo', base_dirty: false, ...patch,
});
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const mergeItems = () => useAttentionStore.getState().items.filter(i => i.kind === 'merge');

let unsubscribe: () => void;
beforeEach(() => {
  current = status();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_task_status') return current;
    return null;
  });
  useTerminalStore.setState({ terminals: new Map([['t', { config, xterm: null, isWorktree: true }]]), terminalStates: new Map([['t', 'idle']]) });
  useAttentionStore.setState({ items: [] });
  useTaskObservationStore.setState({ byTerminal: {} });
});
afterEach(() => { unsubscribe?.(); });

describe('task review poller', () => {
  it('raises one Ready to merge item for a settled task with commits and records the observation', async () => {
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    expect(invoke).toHaveBeenCalledWith('get_task_status', { worktreePath: '/wt/fix' });
    expect(mergeItems()).toHaveLength(1);
    expect(mergeItems()[0]).toMatchObject({ terminalId: 't', title: 'Fix login' });
    expect(useTaskObservationStore.getState().byTerminal.t).toEqual({ status: current });
  });

  it('does not recreate a dismissed item for the same commits, but does after new commits', async () => {
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    useAttentionStore.getState().dismiss('t', 'task');
    useTerminalStore.getState().updateTerminalStatus('t', 'Running');
    useTerminalStore.getState().setTerminalState('t', 'stopped');
    await flush();
    expect(mergeItems()).toHaveLength(0);
    current = status({ ahead: 2, changed_files: ['a.ts', 'b.ts'] });
    useTerminalStore.getState().setTerminalState('t', 'idle');
    await flush();
    expect(mergeItems()).toHaveLength(1);
  });

  it('keeps the item (and its reviewed mark) through repaints, and clears it once the task stops being mergeable', async () => {
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    useAttentionStore.getState().markReviewed('t', 'task');
    // A repaint reads as busy: neither clears nor re-raises the item.
    useTerminalStore.getState().setTerminalState('t', 'busy');
    useTerminalStore.getState().setTerminalState('t', 'idle');
    await flush();
    expect(mergeItems()).toHaveLength(1);
    expect(mergeItems()[0].reviewedAt).toEqual(expect.any(Number));
    current = status({ uncommitted: [{ path: 'a.ts', status: 'M' }] });
    useTerminalStore.getState().setTerminalState('t', 'stopped');
    await flush();
    expect(mergeItems()).toHaveLength(0);
  });

  it('never raises an item while the agent waits for input or for race contenders', async () => {
    useTerminalStore.setState({ terminalStates: new Map([['t', 'waiting']]) });
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    expect(mergeItems()).toHaveLength(0);
    unsubscribe();
    useTerminalStore.setState({ terminals: new Map([['t', { config: { ...config, task: { ...task, raceId: 'r1' } }, xterm: null, isWorktree: true }]]),
      terminalStates: new Map([['t', 'idle']]) });
    invoke.mockClear();
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(mergeItems()).toHaveLength(0);
  });

  it('records a failed status read without crashing or touching items', async () => {
    invoke.mockRejectedValue(new Error('worktree gone'));
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    expect(useTaskObservationStore.getState().byTerminal.t).toEqual({ error: 'Error: worktree gone' });
    expect(mergeItems()).toHaveLength(0);
  });

  it('drops observations when the session closes', async () => {
    unsubscribe = subscribeTaskReview(1_000_000);
    await flush();
    useTerminalStore.setState({ terminals: new Map() });
    expect(useTaskObservationStore.getState().byTerminal).toEqual({});
  });
});
