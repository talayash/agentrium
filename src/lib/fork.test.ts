import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { canFork, forkSession } from './fork';
import { useTerminalStore, type TerminalConfig, type TerminalInstance } from '../store/terminalStore';

const config: TerminalConfig = {
  id: 't1', label: 'Authentication', nickname: null, profile_id: null,
  working_directory: '/project', claude_args: ['--model', 'opus'],
  env_vars: {}, created_at: '', status: 'Running',
  color_tag: null, agent: 'claude', claude_session_id: 'abc',
  credential_bindings: [{ env: 'KEY', credential_id: 'secret-1' }],
  task: { repoPath: '/project', title: 'Task', branch: 'agentrium/task' } as TerminalConfig['task'],
};

const instance = (over: Partial<TerminalConfig> = {}): TerminalInstance => ({
  config: { ...config, ...over }, xterm: null, isWorktree: false,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'create_terminal') return { ...config, id: 'forked' };
    return null;
  });
  useTerminalStore.setState({ terminals: new Map([['t1', instance()]]) });
});

describe('canFork', () => {
  it('is true for claude and codex with a saved session id', () => {
    expect(canFork(instance())).toBe(true);
    expect(canFork(instance({ agent: 'codex' }))).toBe(true);
  });
  it('is false without a session id', () => {
    expect(canFork(instance({ claude_session_id: null }))).toBe(false);
  });
  it('is false for agents without fork support even with an id', () => {
    expect(canFork(instance({ agent: 'cursor' }))).toBe(false);
  });
});

describe('forkSession', () => {
  it('creates a terminal that resumes the source session with fork set', async () => {
    const id = await forkSession('t1');
    expect(id).toBe('forked');
    expect(invoke).toHaveBeenCalledWith('create_terminal', { request: expect.objectContaining({
      working_directory: '/project', claude_args: ['--model', 'opus'],
      resume_session_id: 'abc', fork: true, agent: 'claude',
      credential_bindings: [{ env: 'KEY', credential_id: 'secret-1' }],
      task: config.task,
      label: 'Fork: Authentication',
    }) });
  });
  it('rejects for an unknown source', async () => {
    await expect(forkSession('nope')).rejects.toThrow('The source session is no longer open.');
  });
  it('rejects when the session cannot fork', async () => {
    useTerminalStore.setState({ terminals: new Map([['t1', instance({ agent: 'cursor' })]]) });
    await expect(forkSession('t1')).rejects.toThrow("This agent can't fork a conversation.");
    expect(invoke).not.toHaveBeenCalled();
  });
});
