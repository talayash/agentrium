import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}));
vi.mock('../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
  markAuthPromptSeen: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
vi.mock('./UpdatePill', () => ({ UpdatePill: () => null }));
vi.mock('./titlebar/SessionWidget', () => ({ SessionWidget: () => null }));
vi.mock('./ui/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('../store/terminalStore', () => {
  const state = { terminals: new Map(), gitInfoCache: new Map(), activeTerminalId: null };
  return { useTerminalStore: Object.assign(() => state, { getState: () => state }) };
});

import { TitleBar } from './TitleBar';
import { useAuthStore } from '../store/authStore';
import { startOAuthLogin, markAuthPromptSeen, logout } from '../lib/auth';

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setGuest();
});
afterEach(cleanup);

describe('title bar auth interactions', () => {
  it('drags the title bar but excludes controls and portal content', async () => {
    const user = userEvent.setup();
    render(<StrictMode><TitleBar /></StrictMode>);
    fireEvent.mouseDown(screen.getByAltText('Agentrium'), { buttons: 1 });
    expect(startDragging).toHaveBeenCalledTimes(1);
    startDragging.mockClear();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(startOAuthLogin).toHaveBeenCalledWith('google');
    await user.click(screen.getByRole('button', { name: 'Continue as guest' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(markAuthPromptSeen).toHaveBeenCalledTimes(1);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('allows closing via the close icon and backdrop without starting a drag', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = screen.getByRole('dialog');
    await user.click(dialog.querySelector('button svg')!);
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('supports keyboard activation of sign out', async () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'test@example.com', name: 'Test User', image: null }, 'jwt',
    );
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Account - Test User' }));
    screen.getByRole('menuitem', { name: 'Sign out' }).focus();
    await user.keyboard('{Enter}');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(startDragging).not.toHaveBeenCalled();
  });

  // Regression: the account menu is portalled out of TitleBar's DOM subtree
  // so its clicks miss TitleBar's onMouseDown drag handler (which uses DOM
  // `contains()`). Losing that portal would silently reintroduce the bug
  // where "Sign out" mousedown started a native window drag instead.
  it('mouse-clicks on the portalled Sign out item reach handleSignOut without dragging', async () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'test@example.com', name: 'Test User', image: null }, 'jwt',
    );
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Account - Test User' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(startDragging).not.toHaveBeenCalled();
  });
});
