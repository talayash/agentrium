import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/tabTransfer', () => ({ createDetachedWindow: vi.fn() }));
import { SessionCards } from './SessionCards';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

beforeEach(() => {
  useTerminalStore.setState({
    terminals: new Map([['one', {
      config: { id: 'one', label: 'Agentrium 1', nickname: null, profile_id: null, working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'codex' },
      xterm: null, isWorktree: false,
      sessionContext: { title: 'Fix login redirect', goal: 'Keep users signed in.', latest: 'Checking restart behavior.', updatedAt: '2026-09-15T10:00:00Z', generated: true },
    }]]), activeTerminalId: 'one', unreadTerminalIds: new Set(), gitInfoCache: new Map(), terminalMetrics: new Map(),
  });
  useAppStore.setState({ pinnedTabIds: [], gridTerminalIds: [] });
});
afterEach(cleanup);

describe('session card context', () => {
  it('shows the automatic title and a readable summary on hover', async () => {
    render(<SessionCards />);
    expect(screen.queryByText('Agentrium 1')).toBeNull();
    fireEvent.mouseEnter(screen.getByText('Fix login redirect'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Goal: Keep users signed in.');
    expect(tooltip.textContent).toContain('Latest: Checking restart behavior.');
  });

  it('preserves a manual rename and offers summary refresh afterward', async () => {
    render(<SessionCards />);
    fireEvent.doubleClick(screen.getByText('Fix login redirect'));
    const input = screen.getByRole('textbox', { name: 'Rename session' });
    fireEvent.change(input, { target: { value: 'Authentication task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Authentication task')).toBeTruthy());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Authentication task' }));
    expect(screen.getByRole('menuitem', { name: 'Refresh summary' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Regenerate title and summary' })).toBeNull();
  });
});
