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
