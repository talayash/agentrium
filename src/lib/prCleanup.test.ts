import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { cleanUpPrSessions, cleanupToastMessage, planCleanup, type CleanupCandidate } from './prCleanup';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { prKey } from './pullRequests';
import type { WorktreeDetectResult } from '../types/git';

const cand = (over: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
  terminalId: 't1', busy: false, worktreePath: '/wt/a', uncommitted: 0, ...over,
});

describe('planCleanup', () => {
  it('skips a busy candidate', () => {
    const plan = planCleanup([cand({ busy: true })]);
    expect(plan.close).toEqual([]);
    expect(plan.skipped).toEqual([{ terminalId: 't1', reason: 'Agent is still working' }]);
  });

  it('skips a candidate with uncommitted changes and keeps its worktree', () => {
    const plan = planCleanup([cand({ uncommitted: 3 })]);
    expect(plan.skipped).toEqual([{ terminalId: 't1', reason: 'Uncommitted changes in the worktree' }]);
    expect(plan.removeWorktrees).toEqual([]);
  });

  it('keeps a worktree while any of its sessions is skipped', () => {
    const plan = planCleanup([cand({ terminalId: 't1' }), cand({ terminalId: 't2', busy: true })]);
    expect(plan.close).toEqual(['t1']);
    expect(plan.removeWorktrees).toEqual([]);
  });

  it('removes a shared worktree once when all its sessions close', () => {
    const plan = planCleanup([cand({ terminalId: 't1' }), cand({ terminalId: 't2' })]);
    expect(plan.close).toEqual(['t1', 't2']);
    expect(plan.removeWorktrees).toEqual(['/wt/a']);
  });

  it('closes a non-task session without removing anything', () => {
    const plan = planCleanup([cand({ worktreePath: null })]);
    expect(plan.close).toEqual(['t1']);
    expect(plan.removeWorktrees).toEqual([]);
  });
});

describe('cleanUpPrSessions', () => {
  const KEY = prKey('/repo', 'feat/x');
  const config = (id: string): TerminalConfig => ({
    id, label: id, nickname: null, profile_id: null, working_directory: '/repo', claude_args: [],
    env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude',
  });
  const git: WorktreeDetectResult = {
    is_git_repo: true, is_worktree: false, main_repo_path: null, current_branch: 'feat/x', worktree_root: '/repo',
    dirty_count: 0, ahead: 0, behind: 0,
  };
  let order: string[];

  beforeEach(() => {
    order = [];
    const task = { title: 'T', branch: 'feat/x', baseBranch: 'main', worktreePath: '/repo', repoPath: '/main' };
    useTerminalStore.setState({
      terminals: new Map([['t1', { config: { ...config('t1'), task }, xterm: null, isWorktree: true }]]),
      gitInfoCache: new Map([['t1', git]]),
      terminalStates: new Map([['t1', 'idle']]),
      closeTerminal: async (id: string) => { order.push(`close:${id}`); },
    } as never);
    useAttentionStore.setState({
      items: [{ terminalId: 't1', targetId: 't1', kind: 'merged', title: 'x', detail: 'y', createdAt: 0 }],
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_task_status') return { task: {}, exists: true, uncommitted: [] };
      if (cmd === 'finish_task') { order.push('finish'); return { merged: false }; }
      return null;
    });
  });

  it('closes terminals before finishing the task with keep, and dismisses the pr channel', async () => {
    const plan = await cleanUpPrSessions(KEY);
    expect(plan.close).toEqual(['t1']);
    expect(order).toEqual(['close:t1', 'finish']);
    expect(invoke).toHaveBeenCalledWith('finish_task', { worktreePath: '/repo', action: { kind: 'keep' } });
    expect(useAttentionStore.getState().items).toEqual([]);
  });

  it('keeps a worktree used by a shell terminal that is not a PR candidate', async () => {
    const task = { title: 'T', branch: 'feat/x', baseBranch: 'main', worktreePath: '/repo', repoPath: '/main' };
    useTerminalStore.setState({
      terminals: new Map([
        ['t1', { config: { ...config('t1'), task }, xterm: null, isWorktree: true }],
        ['sh', { config: { ...config('sh'), working_directory: '\\repo\\' }, xterm: null, isWorktree: true, isShellTerminal: true }],
      ]),
      gitInfoCache: new Map([['t1', git]]),
    } as never);
    const plan = await cleanUpPrSessions(KEY);
    expect(plan.close).toEqual(['t1']);
    expect(order).toEqual(['close:t1']);
    expect(plan.removeWorktrees).toEqual([]);
    expect(plan.skipped).toEqual([{ terminalId: '', reason: 'Another open terminal uses this worktree' }]);
    expect(cleanupToastMessage(7, plan)).toBe('Cleaned up 1 session(s) for PR #7');
  });

  it('records a finish_task failure as skipped instead of throwing', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_task_status') return { task: {}, exists: true, uncommitted: [] };
      if (cmd === 'finish_task') throw new Error('locked');
      return null;
    });
    const plan = await cleanUpPrSessions(KEY);
    expect(plan.skipped.some(s => s.reason.includes('locked'))).toBe(true);
  });

  it('keeps going when a close throws and never finishes that worktree', async () => {
    const task = (w: string) => ({ title: 'T', branch: 'feat/x', baseBranch: 'main', worktreePath: w, repoPath: '/main' });
    useTerminalStore.setState({
      terminals: new Map([
        ['t1', { config: { ...config('t1'), task: task('/wt/a') }, xterm: null, isWorktree: true }],
        ['t2', { config: { ...config('t2'), task: task('/wt/a') }, xterm: null, isWorktree: true }],
        ['t3', { config: { ...config('t3'), task: task('/wt/b') }, xterm: null, isWorktree: true }],
      ]),
      gitInfoCache: new Map([['t1', git], ['t2', git], ['t3', git]]),
      terminalStates: new Map(),
      closeTerminal: async (id: string) => {
        if (id === 't1') throw new Error('pty gone');
        order.push(`close:${id}`);
      },
    } as never);
    const plan = await cleanUpPrSessions(KEY);
    expect(plan.close).toEqual(['t2', 't3']);
    expect(plan.skipped).toEqual([{ terminalId: 't1', reason: 'Could not close the session' }]);
    const finished = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'finish_task').map(c => (c[1] as { worktreePath: string }).worktreePath);
    expect(finished).toEqual(['/wt/b']);
  });
});
