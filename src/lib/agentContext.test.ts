import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { stageForAgent, stageTarget } from './agentContext';
import { useAppStore } from '../store/appStore';
import { useTerminalStore, type TerminalConfig, type TerminalInstance } from '../store/terminalStore';

const config: TerminalConfig = {
  id: 't1', label: 'Agent', nickname: null, profile_id: null,
  working_directory: '/project', claude_args: [], env_vars: {}, created_at: '',
  status: 'Running', color_tag: null, agent: 'claude', claude_session_id: null,
};

const instance = (over: Partial<TerminalInstance> = {}): TerminalInstance => ({
  config, xterm: null, isWorktree: false, ...over,
});

beforeEach(() => {
  useAppStore.setState({ promptDrafts: {}, promptEditorOpen: false, promptEditorTargetId: null, promptEditorSeed: null });
  useTerminalStore.setState({ terminals: new Map([['t1', instance()]]), activeTerminalId: 't1' });
});

describe('stageForAgent', () => {
  it('appends the block to an existing draft and opens the prompt editor on it', () => {
    useAppStore.setState({ promptDrafts: { t1: 'A' } });
    const open = vi.spyOn(useAppStore.getState(), 'openPromptEditor');
    stageForAgent('t1', 'B');
    expect(useAppStore.getState().promptDrafts.t1).toBe('A\n\nB');
    expect(open).toHaveBeenCalledWith('t1', 'A\n\nB');
  });

  it('uses the block alone when there is no draft', () => {
    stageForAgent('t1', 'B');
    const s = useAppStore.getState();
    expect(s.promptDrafts.t1).toBe('B');
    expect(s.promptEditorOpen).toBe(true);
    expect(s.promptEditorTargetId).toBe('t1');
    expect(s.promptEditorSeed).toBe('B');
  });

  it('treats a whitespace-only draft as empty', () => {
    useAppStore.setState({ promptDrafts: { t1: '  \n' } });
    stageForAgent('t1', 'B');
    expect(useAppStore.getState().promptDrafts.t1).toBe('B');
  });

  it('never writes to the PTY', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    stageForAgent('t1', 'B');
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'write_to_terminal')).toBe(false);
  });
});

describe('stageTarget', () => {
  it('is the active agent session', () => {
    expect(stageTarget()).toBe('t1');
  });

  it('is null without an active terminal', () => {
    useTerminalStore.setState({ activeTerminalId: null });
    expect(stageTarget()).toBeNull();
    useTerminalStore.setState({ activeTerminalId: 'gone' });
    expect(stageTarget()).toBeNull();
  });

  it('is null for a shell terminal', () => {
    useTerminalStore.setState({ terminals: new Map([['t1', instance({ isShellTerminal: true })]]) });
    expect(stageTarget()).toBeNull();
  });

  it('is null for a script tab', () => {
    useTerminalStore.setState({ terminals: new Map([['t1', instance({ scriptName: 'dev' })]]) });
    expect(stageTarget()).toBeNull();
    useTerminalStore.setState({ terminals: new Map([['t1', instance({ scriptParentId: 'p' })]]) });
    expect(stageTarget()).toBeNull();
  });
});
