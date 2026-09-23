import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { SessionsPanel } from './SessionsPanel';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import type { HistoryProfile } from '../lib/historyGroups';
import { toast } from '../store/toastStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn() }));
vi.mock('../store/toastStore', () => ({ toast: { error: vi.fn() } }));
const ipc = vi.mocked(invoke);
const createTerminal = vi.fn().mockResolvedValue('restored');
let profiles: HistoryProfile[];
let folders: string[];

beforeEach(() => {
  vi.clearAllMocks();
  createTerminal.mockReset().mockResolvedValue('restored');
  profiles = [];
  folders = ['C:\\Reports'];
  useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null, createTerminal });
  useAppStore.setState({ sessionsCollapsed: false, profileModalOpen: false, pinnedRepoPath: '/pinned', gridMode: false,
    defaultAgentArgs: { claude: [], codex: ['--model', 'example'], cursor: [], antigravity: [] } });
  ipc.mockImplementation(async (cmd, args) => {
    if (cmd === 'get_profiles') return profiles;
    if (cmd === 'get_session_history_folders') return folders;
    if (cmd === 'list_agent_sessions') return (args as { agent: string }).agent === 'codex'
      ? [{ id: 'saved', preview: 'Fix reports', modified_at: '2026-09-20T12:00:00Z' }] : [];
    return undefined;
  });
});
afterEach(cleanup);

describe('History with no terminals', () => {
  it('restores a folder session with its agent and defaults even with a pinned folder', async () => {
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByText('Fix reports'));
    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith(
      'Resumed saved', 'C:\\Reports', ['--model', 'example'], {}, undefined, undefined, undefined,
      'saved', undefined, undefined, 'codex', [],
    ));
    expect(ipc).toHaveBeenCalledWith('validate_session_directory', { path: 'C:\\Reports' });
  });

  it('restores profile arguments, environment, credential bindings and preview', async () => {
    profiles = [{ id: 'p', name: 'Work', agent: 'codex', working_directory: 'C:\\Reports', claude_args: ['legacy'],
      agent_args: { codex: ['--model', 'profile-model'] }, env_vars: { TEST: 'value', OPENAI_API_KEY: 'old' },
      credential_bindings: [{ env: 'OPENAI_API_KEY', credential_id: 'key-id' }], preview: { enabled: true } }];
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByText('Fix reports'));
    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith(
      'Work', 'C:\\Reports', ['--model', 'profile-model'], { TEST: 'value' }, undefined, undefined, undefined,
      'saved', undefined, { isOpen: true, userOverride: null, frameworkHint: 'unknown' }, 'codex', profiles[0].credential_bindings,
    ));
  });

  it('reports an inaccessible folder without launching a terminal', async () => {
    const original = ipc.getMockImplementation()!;
    ipc.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'validate_session_directory') throw 'The session folder is missing or inaccessible';
      return original(cmd, args, options);
    });
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByText('Fix reports'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('prevents duplicate restores while a launch is pending', async () => {
    let resolveLaunch!: (id: string) => void;
    createTerminal.mockImplementationOnce(() => new Promise<string>(resolve => { resolveLaunch = resolve; }));
    render(<SessionsPanel />);
    const row = await screen.findByTitle('Restore Fix reports');
    fireEvent.click(row);
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(1));
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(createTerminal).toHaveBeenCalledTimes(1);
    await act(async () => resolveLaunch('restored'));
  });

  it('allows retry after a launch fails', async () => {
    createTerminal.mockRejectedValueOnce(new Error('Agent unavailable'));
    render(<SessionsPanel />);
    const row = await screen.findByTitle('Restore Fix reports');
    fireEvent.click(row);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not restore session', 'Error: Agent unavailable'));
    expect((row as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(row);
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(2));
  });

  it('adds a restored terminal to the grid when grid mode is active', async () => {
    useAppStore.setState({ gridMode: true, gridTerminalIds: [] });
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByText('Fix reports'));
    await waitFor(() => expect(useAppStore.getState().gridTerminalIds).toContain('restored'));
  });

  it('restores legacy profiles using Claude and their saved arguments', async () => {
    profiles = [{ id: 'legacy', name: 'Legacy', working_directory: '/legacy', claude_args: ['--model', 'sonnet'], env_vars: { LANG: 'en_US.UTF-8' } }];
    folders = [];
    const original = ipc.getMockImplementation()!;
    ipc.mockImplementation(async (cmd, args, options) => cmd === 'list_agent_sessions'
      ? [{ id: 'legacy-session', preview: 'Legacy work', modified_at: '2026-09-20T12:00:00Z' }]
      : original(cmd, args, options));
    render(<SessionsPanel />);
    fireEvent.click(await screen.findByText('Legacy work'));
    await waitFor(() => expect(createTerminal).toHaveBeenCalledWith(
      'Legacy', '/legacy', ['--model', 'sonnet'], { LANG: 'en_US.UTF-8' }, undefined, undefined, undefined,
      'legacy-session', undefined, undefined, 'claude', [],
    ));
  });

  it('switches to terminal history when a terminal is created and reloads folders when closed', async () => {
    render(<SessionsPanel />);
    await screen.findByText('Fix reports');
    act(() => {
      useAppStore.setState({ pinnedRepoPath: null });
      useTerminalStore.setState({ activeTerminalId: 't', terminals: new Map([['t', {
        config: { id: 't', label: 'Live', nickname: null, profile_id: null, working_directory: '/live', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude' }, xterm: null, isWorktree: false,
      }]]) });
    });
    await waitFor(() => expect(ipc).toHaveBeenCalledWith('list_agent_sessions', { agent: 'claude', cwd: '/live' }));
    expect(screen.queryByText('C:\\Reports')).toBeNull();
    act(() => useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null }));
    await screen.findByText('Fix reports');
    expect(ipc.mock.calls.filter(c => c[0] === 'get_session_history_folders')).toHaveLength(2);
  });

  it('shows an empty state when there are no profiles or known folders', async () => {
    folders = [];
    render(<SessionsPanel />);
    await screen.findByText('No saved sessions');
  });

  it('hides profiles without history while keeping sessions from other folders', async () => {
    profiles = [{ id: 'empty', name: 'Empty profile', agent: 'claude', working_directory: '/unused', claude_args: [], env_vars: {} }];
    render(<SessionsPanel />);
    await screen.findByText('Fix reports');
    expect(screen.queryByText('Empty profile')).toBeNull();
    expect(screen.queryByText('/unused')).toBeNull();
  });

  it('shows the global empty state when every profile has no sessions', async () => {
    profiles = [{ id: 'empty', name: 'Empty profile', agent: 'claude', working_directory: '/unused', claude_args: [], env_vars: {} }];
    folders = [];
    render(<SessionsPanel />);
    await screen.findByText('No saved sessions');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('ignores an older load after the panel is collapsed and reopened', async () => {
    let resolveOld!: (value: HistoryProfile[]) => void;
    const pending = new Promise<HistoryProfile[]>(resolve => { resolveOld = resolve; });
    const original = ipc.getMockImplementation()!;
    let first = true;
    ipc.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'get_profiles' && first) { first = false; return pending; }
      return original(cmd, args, options);
    });
    render(<SessionsPanel />);
    await screen.findByText('Loading sessions...');
    fireEvent.click(screen.getByTitle('Collapse'));
    fireEvent.click(screen.getByTitle('Expand'));
    await screen.findByText('Fix reports');
    await act(async () => resolveOld([{ id: 'stale', name: 'Stale profile', working_directory: '/old', claude_args: [], env_vars: {} }]));
    expect(screen.queryByText('Stale profile')).toBeNull();
    expect(screen.getByText('Fix reports')).toBeTruthy();
  });

  it('keeps folder sessions available when profile loading fails', async () => {
    const original = ipc.getMockImplementation()!;
    ipc.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'get_profiles') throw new Error('Profile database unavailable');
      return original(cmd, args, options);
    });
    render(<SessionsPanel />);
    await screen.findByText('Fix reports');
    expect(screen.getByRole('alert').textContent).toContain('Some history sources');
  });
});
