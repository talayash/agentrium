import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { SessionsPanel } from './SessionsPanel';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn().mockResolvedValue('C:\\Users\\me') }));
vi.mock('../store/toastStore', () => ({ toast: { error: vi.fn() } }));
const ipc = vi.mocked(invoke);

const CWD = 'C:\\proj.v2';
let onDisk: { id: string; preview: string; modified_at: string }[];

function terminal(id: string, sessionId: string | null = null) {
  return [id, {
    config: { id, label: id, nickname: null, working_directory: CWD, agent: 'claude', claude_session_id: sessionId },
  }] as const;
}

function session(n: number) {
  return { id: `s${n}`, preview: `Conversation ${n}`, modified_at: '2026-10-11T09:00:00Z' };
}

beforeEach(() => {
  vi.clearAllMocks();
  onDisk = [session(1)];
  useAppStore.setState({ sessionsCollapsed: false, pinnedRepoPath: null });
  useTerminalStore.setState({ terminals: new Map([terminal('a')]) as never, activeTerminalId: 'a' });
  ipc.mockImplementation(async (cmd) => {
    if (cmd === 'list_agent_sessions') return [...onDisk];
    if (cmd === 'claude_session_file_path') return 'C:\\resolved\\s1.jsonl';
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Sessions panel stays current (#91)', () => {
  it('reloads when a new terminal opens in the same folder', async () => {
    render(<SessionsPanel />);
    await screen.findByText('Conversation 1');
    onDisk = [session(2), session(1)];
    act(() => {
      useTerminalStore.setState({ terminals: new Map([terminal('a'), terminal('b')]) as never, activeTerminalId: 'b' });
    });
    expect(await screen.findByText('Conversation 2')).toBeTruthy();
  });

  it('reloads when a terminal in the folder picks up a new session id', async () => {
    render(<SessionsPanel />);
    await screen.findByText('Conversation 1');
    onDisk = [session(2), session(1)];
    act(() => {
      useTerminalStore.setState({ terminals: new Map([terminal('a', 's2')]) as never });
    });
    expect(await screen.findByText('Conversation 2')).toBeTruthy();
  });

  it('reloads when the window regains focus', async () => {
    render(<SessionsPanel />);
    await screen.findByText('Conversation 1');
    onDisk = [session(2), session(1)];
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText('Conversation 2')).toBeTruthy();
  });

  it('polls while the panel is expanded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SessionsPanel />);
    await screen.findByText('Conversation 1');
    onDisk = [session(2), session(1)];
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(await screen.findByText('Conversation 2')).toBeTruthy();
  });

  it('does not poll while collapsed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({ sessionsCollapsed: true });
    render(<SessionsPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(ipc).not.toHaveBeenCalledWith('list_agent_sessions', expect.anything());
  });

  it('reveals the path the backend resolves instead of re-encoding the folder', async () => {
    render(<SessionsPanel />);
    fireEvent.contextMenu(await screen.findByText('Conversation 1'));
    fireEvent.click(await screen.findByText(/Show in File Explorer|Reveal in Finder/));
    await waitFor(() => expect(ipc).toHaveBeenCalledWith('reveal_in_file_manager', { path: 'C:\\resolved\\s1.jsonl' }));
    expect(ipc).toHaveBeenCalledWith('claude_session_file_path', { cwd: CWD, id: 's1' });
  });
});
