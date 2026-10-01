import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  buildSquashMessage, defaultMergeMode, finishActionFor, launchTask, mergeBlockReason, normalizeTask,
  requestCloseTerminal, restoreTargetFor, setupFilesFor, type TaskInfo, type TaskStatus,
} from './tasks';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

const task: TaskInfo = {
  title: 'Fix login bug', branch: 'agentrium/fix-login-bug', baseBranch: 'main',
  worktreePath: '/src/.agentrium-worktrees/app/fix-login-bug', repoPath: '/src/app',
};

const baseConfig: TerminalConfig = {
  id: 't1', label: 'Fix login bug', nickname: 'Fix login bug', profile_id: null,
  working_directory: task.worktreePath, claude_args: [], env_vars: {}, created_at: '',
  status: 'Running', color_tag: null, agent: 'codex', credential_bindings: [], task,
};

function status(over: Partial<TaskStatus> = {}): TaskStatus {
  return { task, exists: true, uncommitted: [], ahead: 2, behind: 0, changed_files: ['a.ts'],
    base_worktree: '/src/app', base_dirty: false, ...over };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null, taskDivergence: new Map() });
  useAppStore.setState({
    promptDrafts: {}, promptEditorOpen: false, finishTaskTerminalId: null, finishTaskCloseAfter: false,
    taskWorktreeRoot: '', taskSetupFiles: {},
    defaultAgentArgs: { claude: [], codex: ['--model', 'm'], cursor: [], antigravity: [] },
  });
});

describe('task metadata helpers', () => {
  it('normalizes only complete task rows', () => {
    expect(normalizeTask(task)).toEqual(task);
    expect(normalizeTask(null)).toBeNull();
    expect(normalizeTask({ ...task, branch: '' })).toBeNull();
    expect(normalizeTask({ title: 'x' })).toBeNull();
  });

  it('uses the default setup files unless the repo has its own list', () => {
    expect(setupFilesFor('/r', {})).toEqual(['.env', '.env.local']);
    expect(setupFilesFor('/r', { '/r': ['.env.test'] })).toEqual(['.env.test']);
  });

  it('seeds the merge mode from the Git setting', () => {
    expect(defaultMergeMode('ff-only', 0)).toBe('fast-forward');
    expect(defaultMergeMode('ff-only', 3)).toBe('squash');
    expect(defaultMergeMode('merge', 0)).toBe('squash');
  });

  it('prefills the squash message from the title and changed files', () => {
    expect(buildSquashMessage(' Fix login ', [])).toBe('Fix login');
    expect(buildSquashMessage('Fix', ['a.ts', 'b.ts'])).toBe('Fix\n\n- a.ts\n- b.ts');
    const many = Array.from({ length: 52 }, (_, i) => `f${i}`);
    expect(buildSquashMessage('T', many)).toContain('...and 2 more');
  });
});

describe('finish dialog choices', () => {
  it('explains why a merge is blocked', () => {
    expect(mergeBlockReason(status({ base_dirty: true }), 'squash')).toMatch(/uncommitted changes in \/src\/app/);
    expect(mergeBlockReason(status({ ahead: 0, uncommitted: [{ path: 'a', status: 'M' }] }), 'squash')).toMatch(/Commit its changes first/);
    expect(mergeBlockReason(status({ behind: 1 }), 'fast-forward')).toMatch(/Fast-forward is impossible/);
    expect(mergeBlockReason(status({ base_worktree: null }), 'squash')).toMatch(/not checked out/);
    expect(mergeBlockReason(status({ base_worktree: null }), 'fast-forward')).toBeNull();
    expect(mergeBlockReason(status(), 'squash')).toBeNull();
  });

  it('maps choices to backend actions and asks before discarding unmerged work', () => {
    const opts = { mode: 'squash' as const, message: '  msg  ', ahead: 2, confirmedDiscard: false };
    expect(finishActionFor('merge', opts)).toEqual({ kind: 'merge', mode: 'squash', message: 'msg' });
    expect(finishActionFor('merge', { ...opts, message: ' ' })).toEqual({ kind: 'merge', mode: 'squash', message: null });
    expect(finishActionFor('keep', opts)).toEqual({ kind: 'keep' });
    expect(finishActionFor('discard', opts)).toBe('needs-confirmation');
    expect(finishActionFor('discard', { ...opts, confirmedDiscard: true })).toEqual({ kind: 'discard', confirm_unmerged: true });
    expect(finishActionFor('discard', { ...opts, ahead: 0 })).toEqual({ kind: 'discard', confirm_unmerged: false });
  });

  it('routes a task terminal close through the finish dialog', async () => {
    useTerminalStore.setState({ terminals: new Map([['t1', { config: baseConfig, xterm: null, isWorktree: false }]]) });
    await requestCloseTerminal('t1');
    expect(useAppStore.getState().finishTaskTerminalId).toBe('t1');
    expect(useAppStore.getState().finishTaskCloseAfter).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('close_terminal', expect.anything());
  });

  it('closes a plain terminal directly', async () => {
    const plain = { ...baseConfig, id: 'p', task: null };
    useTerminalStore.setState({ terminals: new Map([['p', { config: plain, xterm: null, isWorktree: false }]]) });
    vi.mocked(invoke).mockResolvedValue(undefined);
    await requestCloseTerminal('p');
    expect(invoke).toHaveBeenCalledWith('close_terminal', { id: 'p' });
    expect(useAppStore.getState().finishTaskTerminalId).toBeNull();
  });
});

describe('launchTask', () => {
  it('creates the worktree, then a terminal named after the task, and stages the title without typing into the PTY', async () => {
    useAppStore.setState({ taskWorktreeRoot: '/wt', taskSetupFiles: { '/src/app': ['.env'] } });
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'start_task') return { worktree_path: task.worktreePath, branch: task.branch, base_branch: 'main', repo_path: '/src/app', copied_files: [] };
      if (cmd === 'create_terminal') return { ...baseConfig, task: (args as { request: { task: TaskInfo } }).request.task };
      return null;
    });
    const id = await launchTask({ repoPath: '/src/app', title: 'Fix login bug', agent: 'codex', titleAsPrompt: true });
    expect(invoke).toHaveBeenCalledWith('start_task', { request: {
      repo_path: '/src/app', title: 'Fix login bug', base_branch: null, branch_name: null,
      worktree_root: '/wt', setup_files: ['.env'],
    } });
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({ request: expect.objectContaining({
      label: 'Fix login bug', nickname: 'Fix login bug', working_directory: task.worktreePath,
      agent: 'codex', claude_args: ['--model', 'm'], task,
    }) }));
    expect(useTerminalStore.getState().terminals.get(id)?.config.task).toEqual(task);
    expect(useAppStore.getState().promptDrafts[id]).toBe('Fix login bug');
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'write_to_terminal')).toBe(false);
  });

  it('does not stage a prompt when the toggle is off', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'start_task') return { worktree_path: task.worktreePath, branch: task.branch, base_branch: 'main', repo_path: '/src/app', copied_files: [] };
      if (cmd === 'create_terminal') return baseConfig;
      return null;
    });
    const id = await launchTask({ repoPath: '/src/app', title: 'Fix login bug', agent: 'codex', titleAsPrompt: false });
    expect(useAppStore.getState().promptDrafts[id]).toBeUndefined();
  });

  it('rolls the fresh worktree back when the terminal cannot start', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'start_task') return { worktree_path: task.worktreePath, branch: task.branch, base_branch: 'main', repo_path: '/src/app', copied_files: [] };
      if (cmd === 'create_terminal') throw new Error('Agent not installed');
      return null;
    });
    await expect(launchTask({ repoPath: '/src/app', title: 'x', agent: 'codex', titleAsPrompt: false })).rejects.toThrow('Agent not installed');
    expect(invoke).toHaveBeenCalledWith('finish_task', { worktreePath: task.worktreePath, action: { kind: 'discard', confirm_unmerged: false } });
  });

  it('refuses an empty title before touching git', async () => {
    await expect(launchTask({ repoPath: '/src/app', title: '  ', agent: 'codex', titleAsPrompt: false })).rejects.toThrow('title');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('session restore round-trip', () => {
  it('a saved task terminal reopens in its worktree with the same task', async () => {
    // What save_session_for_restore writes and get_last_session returns.
    const saved = JSON.parse(JSON.stringify(baseConfig));
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'validate_session_directory') return null;
      if (cmd === 'create_terminal') return { ...baseConfig, id: 'restored', task: (args as { request: { task: TaskInfo } }).request.task };
      return null;
    });
    const target = await restoreTargetFor(saved);
    expect(target).toEqual({ cwd: task.worktreePath, task, worktreeMissing: false });
    const id = await useTerminalStore.getState().createTerminal(
      saved.label, target.cwd, saved.claude_args, saved.env_vars, undefined, saved.nickname,
      undefined, undefined, false, undefined, saved.agent, saved.credential_bindings, target.task,
    );
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({
      request: expect.objectContaining({ working_directory: task.worktreePath, task }),
    }));
    expect(useTerminalStore.getState().terminals.get(id)?.config.task).toEqual(task);
  });

  it('falls back to the repo root without the task when the worktree is gone', async () => {
    vi.mocked(invoke).mockRejectedValue('The session folder is missing');
    expect(await restoreTargetFor(baseConfig)).toEqual({ cwd: '/src/app', task: null, worktreeMissing: true });
  });

  it('leaves non-task terminals untouched', async () => {
    expect(await restoreTargetFor({ working_directory: '/x' })).toEqual({ cwd: '/x', task: null, worktreeMissing: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('task divergence badges', () => {
  it('fetchGitInfo records ahead/behind for task terminals only', async () => {
    useTerminalStore.setState({ terminals: new Map([
      ['t1', { config: baseConfig, xterm: null, isWorktree: false }],
      ['p', { config: { ...baseConfig, id: 'p', task: null }, xterm: null, isWorktree: false }],
    ]) });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'get_worktree_info') return { is_git_repo: true, is_worktree: true };
      if (cmd === 'get_task_status') return status({ ahead: 3, behind: 1 });
      return null;
    });
    await useTerminalStore.getState().fetchGitInfo('t1');
    await useTerminalStore.getState().fetchGitInfo('p');
    expect(useTerminalStore.getState().taskDivergence.get('t1')).toEqual({ ahead: 3, behind: 1 });
    expect(useTerminalStore.getState().taskDivergence.has('p')).toBe(false);
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'get_task_status')).toHaveLength(1);
  });
});
