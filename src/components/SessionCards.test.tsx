import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/tabTransfer', () => ({ createDetachedWindow: vi.fn() }));
import { SessionCards } from './SessionCards';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';

beforeEach(() => {
  useSessionAttentionStore.setState({ pending: new Set(), acknowledged: new Set() });
  useTerminalStore.setState({
    terminals: new Map([['one', {
      config: { id: 'one', label: 'Agentrium 1', nickname: null, profile_id: null, working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'codex' },
      xterm: null, isWorktree: false,
      sessionContext: { title: 'Fix login redirect', goal: 'Keep users signed in.', latest: 'Checking restart behavior.', updatedAt: '2026-09-15T10:00:00Z', generated: true },
    }]]), activeTerminalId: 'one', unreadTerminalIds: new Set(), gitInfoCache: new Map(), terminalMetrics: new Map(), terminalStates: new Map([['one', 'waiting']]),
  });
  useAppStore.setState({ pinnedTabIds: [], gridTerminalIds: [] });
});
afterEach(cleanup);

describe('session card context', () => {
  it('pulses only while a running session is busy', () => {
    useTerminalStore.setState({ terminalStates: new Map([['one', 'idle']]) });
    render(<SessionCards />);
    expect(screen.getByRole('img', { name: 'Session idle' }).classList.contains('session-busy-dot')).toBe(false);
    act(() => useTerminalStore.getState().setTerminalState('one', 'busy'));
    expect(screen.getByRole('img', { name: 'Working' }).classList.contains('session-busy-dot')).toBe(true);
    act(() => useTerminalStore.getState().setTerminalState('one', 'idle'));
    expect(screen.getByRole('img', { name: 'Session idle' }).classList.contains('session-busy-dot')).toBe(false);
    act(() => {
      useTerminalStore.getState().setTerminalState('one', 'busy');
      const t = useTerminalStore.getState().terminals.get('one')!;
      useTerminalStore.setState({ terminals: new Map([['one', { ...t, config: { ...t.config, status: 'Stopped' } }]]) });
    });
    expect(screen.queryByRole('img', { name: 'Working' })).toBeNull();
  });

  it('highlights a pending prompt and acknowledges it on click', () => {
    useSessionAttentionStore.getState().request('one');
    render(<SessionCards />);
    const card = screen.getByRole('button', { name: 'Agentrium 1' });
    expect(card.classList.contains('session-needs-attention')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Needs your input');
    expect(card.dataset.attention).toBe('input');
    fireEvent.click(card);
    expect(screen.queryByText('Needs your input')).toBeNull();
    expect(useSessionAttentionStore.getState().acknowledged.has('one')).toBe(true);
  });

  it('marks a finished turn as ready, not input', () => {
    useTerminalStore.setState({ terminalStates: new Map([['one', 'idle']]) });
    useSessionAttentionStore.getState().request('one');
    render(<SessionCards />);
    expect(screen.getByRole('status').textContent).toBe('Response ready');
    expect(screen.getByRole('button', { name: 'Agentrium 1' }).dataset.attention).toBe('ready');
  });

  it('does not turn ordinary unread output into an input alert', () => {
    useTerminalStore.setState({ activeTerminalId: null, unreadTerminalIds: new Set(['one']) });
    render(<SessionCards />);
    expect(screen.getByLabelText('Unread output')).toBeTruthy();
    expect(screen.queryByText('Needs your input')).toBeNull();
  });
  it('keeps the original name when no context is available', () => {
    const terminal = useTerminalStore.getState().terminals.get('one')!;
    useTerminalStore.setState({ terminals: new Map([['one', { ...terminal, sessionContext: null }]]) });
    render(<SessionCards />);
    expect(screen.getByRole('button', { name: 'Agentrium 1' })).toBeTruthy();
    expect(screen.queryByText('Fix login redirect')).toBeNull();
  });

  it('hides a subtitle identical to the main name', () => {
    const terminal = useTerminalStore.getState().terminals.get('one')!;
    useTerminalStore.getState().setSessionContext('one', { ...terminal.sessionContext!, title: 'Agentrium 1' });
    render(<SessionCards />);
    expect(screen.getAllByText('Agentrium 1')).toHaveLength(1);
  });

  it('shows a stable main title, automatic subtitle and summary on hover', async () => {
    render(<SessionCards />);
    expect(screen.getByRole('button', { name: 'Agentrium 1' })).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText('Fix login redirect'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Goal: Keep users signed in.');
    expect(tooltip.textContent).toContain('Latest: Checking restart behavior.');
  });

  it('preserves a manual rename and offers summary refresh afterward', async () => {
    render(<SessionCards />);
    fireEvent.doubleClick(screen.getByText('Agentrium 1'));
    const input = screen.getByRole('textbox', { name: 'Rename session' });
    fireEvent.change(input, { target: { value: 'Authentication task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Authentication task')).toBeTruthy());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Authentication task' }));
    expect(screen.getByRole('menuitem', { name: 'Refresh context' })).toBeTruthy();
    expect(screen.getByText('Fix login redirect')).toBeTruthy();
  });
});
