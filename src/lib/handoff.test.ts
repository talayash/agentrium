import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { buildHandoffBrief, launchHandoff } from './handoff';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

const config: TerminalConfig = {
  id: 'source', label: 'Authentication', nickname: null, profile_id: null,
  working_directory: '/project/worktree', claude_args: ['--resume=old-session'],
  env_vars: { PRIVATE_KEY: 'do-not-copy' }, created_at: '', status: 'Running',
  color_tag: null, agent: 'claude', claude_session_id: 'old-session',
  credential_bindings: [{ env: 'SOURCE_KEY', credential_id: 'source-secret' }],
};

beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map([['source', {
    config, xterm: null, isWorktree: true,
    sessionContext: { title: 'Login', goal: 'Fix login', latest: 'Updated callback', updatedAt: '', generated: false },
  }]]) });
  useAppStore.setState({ promptDrafts: {}, promptEditorOpen: false, defaultAgentArgs: { claude: [], codex: ['--model', 'chosen-model'], cursor: [], antigravity: [] } });
  useAgentRegistryStore.setState({ builtinBindings: { codex: [{ env: 'TARGET_KEY', credential_id: 'target-secret' }] } });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'create_terminal') return { ...config, id: 'target', agent: 'codex' };
    return null;
  });
});

describe('agent handoff', () => {
  it('builds an editable brief from context and working tree paths without copying launch secrets', () => {
    const brief = buildHandoffBrief('source', { branch: 'fix/login', repo_root: '/project', is_git_repo: true, error: null,
      changes: [{ path: 'src/auth.ts', status: 'modified', staged: true }] });
    expect(brief).toContain('Fix login');
    expect(brief).toContain('Updated callback');
    expect(brief).toContain('fix/login');
    expect(brief).toContain('src/auth.ts (modified, staged)');
    expect(brief).toContain('## Decisions');
    expect(brief).toContain('## Remaining work');
    expect(brief).not.toContain('do-not-copy');
    expect(brief).not.toContain('old-session');
  });

  it('launches with the receiving agent defaults and stages the exact edited brief without writing to the PTY', async () => {
    await launchHandoff('source', 'codex', 'My edited brief');
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({ request: expect.objectContaining({
      working_directory: '/project/worktree', agent: 'codex', claude_args: ['--model', 'chosen-model'],
      env_vars: {}, resume_session_id: null, continue_recent: false,
      credential_bindings: [{ env: 'TARGET_KEY', credential_id: 'target-secret' }],
    }) }));
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'write_to_terminal')).toBe(false);
    expect(useTerminalStore.getState().terminals.has('source')).toBe(true);
    expect(useAppStore.getState().promptDrafts.target).toBe('My edited brief');
    expect(useAppStore.getState().promptEditorTargetId).toBe('target');
    expect(useAppStore.getState().promptEditorOpen).toBe(true);
  });

  it('does not launch after the source closes or with an empty brief', async () => {
    await expect(launchHandoff('source', 'codex', '  ')).rejects.toThrow('Add a handoff brief');
    useTerminalStore.setState({ terminals: new Map() });
    await expect(launchHandoff('source', 'codex', 'brief')).rejects.toThrow('no longer open');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the source and does not open an editor when spawning fails', async () => {
    vi.mocked(invoke).mockImplementation(async cmd => { if (cmd === 'create_terminal') throw new Error('Agent not installed'); return null; });
    await expect(launchHandoff('source', 'codex', 'brief')).rejects.toThrow('Agent not installed');
    expect(useTerminalStore.getState().terminals.has('source')).toBe(true);
    expect(useAppStore.getState().promptEditorOpen).toBe(false);
  });
});

describe('agent handoff from a task session', () => {
  const task = { title: 'Login', branch: 'agentrium/login', baseBranch: 'main', worktreePath: '/wt/login', repoPath: '/project' };
  beforeEach(() => {
    useTerminalStore.setState({ terminals: new Map([['source', { config: { ...config, working_directory: task.worktreePath, task }, xterm: null, isWorktree: false }]]) });
  });

  it('defaults to the same worktree and carries the task', async () => {
    await launchHandoff('source', 'codex', 'brief');
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({ request: expect.objectContaining({
      working_directory: task.worktreePath, task,
    }) }));
    expect(invoke).not.toHaveBeenCalledWith('start_task', expect.anything());
  });

  it('forks into a new task worktree based on the source task branch', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'start_task') return { worktree_path: '/wt/login-fork', branch: 'agentrium/login-fork', base_branch: 'agentrium/login', repo_path: '/project', copied_files: [] };
      if (command === 'create_terminal') return { ...config, id: 'fork', agent: 'codex', task: (args as { request: { task: unknown } }).request.task };
      return null;
    });
    const id = await launchHandoff('source', 'codex', 'fork brief', 'fork');
    expect(invoke).toHaveBeenCalledWith('start_task', { request: expect.objectContaining({
      repo_path: '/project', title: 'Login (fork)', base_branch: 'agentrium/login',
    }) });
    expect(invoke).toHaveBeenCalledWith('create_terminal', expect.objectContaining({ request: expect.objectContaining({
      working_directory: '/wt/login-fork',
      task: { title: 'Login (fork)', branch: 'agentrium/login-fork', baseBranch: 'agentrium/login', worktreePath: '/wt/login-fork', repoPath: '/project' },
    }) }));
    expect(useAppStore.getState().promptDrafts[id]).toBe('fork brief');
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'write_to_terminal')).toBe(false);
  });
});
