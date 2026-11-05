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
  it('sits right after the browser button in the tools capsule', () => {
    render(<TitleBar />);
    const browser = screen.getByRole('button', { name: 'Open browser' });
    const browserWrapper = browser.closest('.glass-capsule > *') ?? browser;
    const next = browserWrapper.nextElementSibling;
    expect(next?.contains(gridButton())).toBe(true);
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
    expect(gridButton().textContent).toBe('2');
  });

  it('shows no count badge when the grid is empty', () => {
    render(<TitleBar />);
    expect(gridButton().textContent).toBe('');
  });
});
