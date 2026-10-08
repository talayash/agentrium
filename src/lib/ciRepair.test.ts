import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { canRepairCi, launchCiRepair, loadCiRepairContext, openRepairFor } from './ciRepair';
import { prKey, type PullRequestStatus } from './pullRequests';
import type { TaskInfo } from './tasks';
import { useAppStore } from '../store/appStore';
import { useCiRepairStore } from '../store/ciRepairStore';
import { usePrStore } from '../store/prStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

const key = prKey('/src/app', 'feat/login');
const failing: PullRequestStatus = {
  number: 12, url: 'https://github.com/o/r/pull/12', provider: 'github', state: 'open', draft: false,
  review_decision: null, mergeable: 'mergeable',
  ci: { state: 'failure', total: 2, failing: [{ name: 'test', url: 'https://github.com/o/r/actions/runs/9/job/1' }] },
};
const source: TerminalConfig = {
  id: 's1', label: 'Login', nickname: null, profile_id: null, working_directory: '/src/app', claude_args: [],
  env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [],
};
const repairTask: TaskInfo = {
  title: 'Fix CI on #12', branch: 'agentrium/fix-ci-on-12', baseBranch: 'feat/login',
  worktreePath: '/src/.agentrium-worktrees/app/fix-ci-on-12', repoPath: '/src/app',
};
const PUSHING = ['push_changes', 'git_push', 'create_pull_request'];

function mockBackend(over: Record<string, (args: unknown) => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (over[cmd]) return over[cmd](args);
    switch (cmd) {
      case 'get_failing_check_logs': return '### Run 9 boom';
      case 'get_pull_request_details': return { title: 'Add login', body: 'Adds it.', base_branch: 'main', head_sha: 'abc1234' };
      case 'get_pr_context': return { base_ref: 'origin/main', commits: [{ short_sha: 'abc1234', subject: 'Add form' }], files: [{ status: 'M', path: 'a.ts' }] };
      case 'start_task': return { worktree_path: repairTask.worktreePath, branch: repairTask.branch, base_branch: 'feat/login', repo_path: '/src/app', copied_files: [] };
      case 'create_terminal': return {
        ...source, id: 'r1', working_directory: repairTask.worktreePath,
        task: (args as { request: { task: TaskInfo } }).request.task, prompt_delivery: { mode: 'argv' },
      };
      default: return null;
    }
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useTerminalStore.setState({
    terminals: new Map([['s1', { config: source, xterm: null, isWorktree: false }]]),
    activeTerminalId: 's1',
    gitInfoCache: new Map([['s1', { is_git_repo: true, current_branch: 'feat/login', worktree_root: '/src/app', is_worktree: false } as never]]),
  });
  usePrStore.setState({ refs: {}, statuses: { [key]: failing } });
  useCiRepairStore.setState({ repairs: {} });
  useAppStore.setState({
    promptDrafts: {}, promptEditorOpen: false, gridMode: false, splitMode: false,
    taskWorktreeRoot: '', taskSetupFiles: {},
    defaultAgentArgs: { claude: [], codex: [], cursor: [], antigravity: [] },
  });
});

describe('loadCiRepairContext', () => {
  it('collects logs, PR details and the branch changes against the PR base', async () => {
    mockBackend();
    const loaded = await loadCiRepairContext('s1');
    expect(invoke).toHaveBeenCalledWith('get_failing_check_logs', { path: '/src/app', branch: 'feat/login' });
    expect(invoke).toHaveBeenCalledWith('get_pull_request_details', { path: '/src/app', branch: 'feat/login' });
    expect(invoke).toHaveBeenCalledWith('get_pr_context', { path: '/src/app', base: 'main' });
    expect(loaded.unavailable).toEqual([]);
    expect(loaded.repoPath).toBe('/src/app');
    expect(loaded.context.logs).toBe('### Run 9 boom');
  });

  it('still loads when the optional pieces fail, and lists what is missing', async () => {
    mockBackend({
      get_failing_check_logs: () => { throw new Error('gh not signed in'); },
      get_pull_request_details: () => null,
    });
    const loaded = await loadCiRepairContext('s1');
    expect(loaded.unavailable).toEqual(['failed job logs', 'pull request description', 'changed files and latest commit']);
    expect(invoke).not.toHaveBeenCalledWith('get_pr_context', expect.anything());
  });

  it('refuses when CI is not failing', async () => {
    usePrStore.setState({ statuses: { [key]: { ...failing, ci: { state: 'success', total: 2, failing: [] } } } });
    expect(canRepairCi('s1')).toBe(false);
    await expect(loadCiRepairContext('s1')).rejects.toThrow('not failing');
  });
});

describe('launchCiRepair', () => {
  it('starts a task off the PR branch, sends the brief at spawn, records the repair, and never pushes', async () => {
    mockBackend();
    const loaded = await loadCiRepairContext('s1');
    const result = await launchCiRepair(loaded, 'claude', 'Repair brief');
    expect(invoke).toHaveBeenCalledWith('start_task', { request: expect.objectContaining({
      repo_path: '/src/app', title: 'Fix CI on #12', base_branch: 'feat/login',
    }) });
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({
      request: expect.objectContaining({ initial_prompt: 'Repair brief', working_directory: repairTask.worktreePath }),
    }));
    expect(result).toEqual({ terminalId: 'r1', staged: false });
    expect(useTerminalStore.getState().activeTerminalId).toBe('r1');
    expect(useAppStore.getState().promptEditorOpen).toBe(false);
    const found = openRepairFor(useCiRepairStore.getState().repairs, key);
    expect(found).toMatchObject({ terminalId: 'r1', repair: { prNumber: 12, branch: 'feat/login' } });
    const commands = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(commands.filter((c) => PUSHING.includes(c) || c === 'write_to_terminal')).toEqual([]);
  });

  it('stages the brief in the prompt editor when the agent cannot take it at spawn', async () => {
    mockBackend({ create_terminal: (args) => ({
      ...source, id: 'r1', agent: 'cursor', task: (args as { request: { task: TaskInfo } }).request.task, prompt_delivery: { mode: 'staged' },
    }) });
    const loaded = await loadCiRepairContext('s1');
    const result = await launchCiRepair(loaded, 'cursor', 'Repair brief');
    expect(result.staged).toBe(true);
    expect(useAppStore.getState().promptDrafts.r1).toBe('Repair brief');
    expect(useAppStore.getState().promptEditorOpen).toBe(true);
  });

  it('rolls the worktree back and records nothing when the agent cannot start', async () => {
    mockBackend({ create_terminal: () => { throw new Error('Agent not installed'); } });
    const loaded = await loadCiRepairContext('s1');
    await expect(launchCiRepair(loaded, 'claude', 'Repair brief')).rejects.toThrow('Agent not installed');
    expect(invoke).toHaveBeenCalledWith('finish_task', { worktreePath: repairTask.worktreePath, action: { kind: 'discard', confirm_unmerged: false } });
    expect(useCiRepairStore.getState().repairs).toEqual({});
    expect(useTerminalStore.getState().activeTerminalId).toBe('s1');
  });

  it('refuses an empty brief before touching git', async () => {
    mockBackend();
    const loaded = await loadCiRepairContext('s1');
    await expect(launchCiRepair(loaded, 'claude', '   ')).rejects.toThrow('brief');
    expect(invoke).not.toHaveBeenCalledWith('start_task', expect.anything());
  });
});
