import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));
vi.mock('../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
  markAuthPromptSeen: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  signupCredentials: vi.fn().mockResolvedValue(undefined),
  signinCredentials: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/sync', () => ({
  setSyncEnabled: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn(),
  subscribeToSyncEvents: vi.fn().mockResolvedValue(() => {}),
  getSyncEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }));
vi.mock('./titlebar/WaitingPill', () => ({ WaitingPill: () => null }));
vi.mock('./ui/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('../store/terminalStore', () => {
  const state = { terminals: new Map(), gitInfoCache: new Map(), activeTerminalId: null };
  return { useTerminalStore: Object.assign(() => state, { getState: () => state }) };
});

import { TitleBar } from './TitleBar';
import { useAppStore } from '../store/appStore';

const gridButton = () => screen.getByRole('button', { name: 'Toggle Grid View' });

beforeEach(() => {
  useAppStore.setState({ gridMode: false, gridTerminalIds: [] });
});
afterEach(cleanup);

describe('title bar grid toggle', () => {
  it('sits between Browser and Inspector in the labelled panels track', () => {
    render(<TitleBar />);
    const track = screen.getByRole('group', { name: 'Panels' });
    const buttons = Array.from(track.querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Open browser', 'Toggle Grid View', 'Open Inspector']);
    expect(buttons.map((b) => b.querySelector('.toolbar-toggle-label')?.textContent)).toEqual(['Browser', 'Grid', 'Inspector']);
  });

  it('reflects and toggles grid mode', () => {
    const toggleGridMode = vi.fn(() => useAppStore.setState({ gridMode: !useAppStore.getState().gridMode }));
    useAppStore.setState({ toggleGridMode });
    render(<TitleBar />);
    expect(gridButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(gridButton());
    expect(toggleGridMode).toHaveBeenCalledTimes(1);
    expect(gridButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('shows how many terminals are in the grid', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b'] });
    render(<TitleBar />);
    expect(gridButton().querySelector('.toolbar-toggle-count')?.textContent).toBe('2');
  });

  it('keeps the session tab free-standing when no session surface is below it', () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector('.session-tab')?.getAttribute('data-merged')).toBe('false');
  });

  it('shows no count chip when the grid is empty', () => {
    render(<TitleBar />);
    expect(gridButton().querySelector('.toolbar-toggle-count')).toBeNull();
  });
});
