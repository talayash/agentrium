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
vi.mock('./titlebar/SessionWidget', () => ({ SessionWidget: () => null }));
vi.mock('./ui/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('../store/terminalStore', () => {
  const state = { terminals: new Map(), gitInfoCache: new Map(), activeTerminalId: null };
  return { useTerminalStore: Object.assign(() => state, { getState: () => state }) };
});

import { TitleBar } from './TitleBar';
import { useAuthStore } from '../store/authStore';
import { startOAuthLogin, markAuthPromptSeen, logout, signupCredentials, signinCredentials } from '../lib/auth';
import { setSyncEnabled } from '../lib/sync';
import { useSyncStore } from '../store/syncStore';

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setGuest();
  useSyncStore.setState({
    status: 'idle',
    enabled: true,
    queueDepth: 0,
    lastPulledAt: null,
    lastError: null,
  } as any);
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

  it('starts a GitHub OAuth flow from the login modal', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(startOAuthLogin).toHaveBeenCalledWith('github');
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

  it('toggling Sync off in the account dropdown calls setSyncEnabled(false)', async () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'test@example.com', name: 'Test User', image: null },
      'jwt',
    );
    // Sync starts enabled by default.
    useSyncStore.setState({ enabled: true } as any);

    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Account - Test User' }));
    await user.click(screen.getByRole('switch', { name: 'Sync on' }));
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
  });

  it('toggling Sync on in the account dropdown calls setSyncEnabled(true)', async () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'test@example.com', name: 'Test User', image: null },
      'jwt',
    );
    useSyncStore.setState({ enabled: false } as any);

    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Account - Test User' }));
    await user.click(screen.getByRole('switch', { name: 'Sync off' }));
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
  });

  it('opens the email+password form under the "Or use email + password" link', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    // Form is now visible
    expect(screen.getByLabelText(/^Email$/i)).toBeTruthy();
    expect(screen.getByLabelText(/^Password$/i)).toBeTruthy();
  });

  it('signs in with email + password', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    await user.type(screen.getByLabelText(/^Email$/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'password123');
    // Two "Sign in" buttons exist: the header pill (outside any form) and the
    // form's submit button (inside a <form>). Pick the one inside the form.
    const submits = screen.getAllByRole('button', { name: 'Sign in' }) as HTMLButtonElement[];
    const submit = submits.find((b) => b.closest('form') !== null);
    if (!submit) throw new Error('no form Sign in button');
    await user.click(submit);
    expect(signinCredentials).toHaveBeenCalledWith('me@example.com', 'password123');
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('creates an account when toggled to sign-up mode', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    await user.click(screen.getByRole('button', { name: /Don't have an account\? Create one/i }));
    // Now in signup mode: name field appears, submit button says "Create account"
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    await user.type(screen.getByLabelText(/^Email$/i), 'new@example.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'password123');
    await user.type(screen.getByLabelText(/name/i), 'New User');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(signupCredentials).toHaveBeenCalledWith('new@example.com', 'password123', 'New User');
  });

  it('shows "Sign in instead" message on duplicate email', async () => {
    (signupCredentials as any).mockRejectedValueOnce(new Error('email_taken'));
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    await user.click(screen.getByRole('button', { name: /Create one/i }));
    await user.type(screen.getByLabelText(/^Email$/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'password123');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/already registered/i);
  });

  it('shows "Wrong email or password" on invalid credentials', async () => {
    (signinCredentials as any).mockRejectedValueOnce(new Error('invalid_credentials'));
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    await user.type(screen.getByLabelText(/^Email$/i), 'wrong@example.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'wrongpassword');
    const submits = screen.getAllByRole('button', { name: 'Sign in' }) as HTMLButtonElement[];
    const submit = submits.find((b) => b.closest('form') !== null);
    if (!submit) throw new Error('no form Sign in button');
    await user.click(submit);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/wrong email or password/i);
  });

  it('submit button is disabled when password is shorter than 8 chars', async () => {
    const user = userEvent.setup();
    render(<TitleBar />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
    await user.type(screen.getByLabelText(/^Email$/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^Password$/i), 'short');
    // The form's submit exists but should be disabled. The header pill (the
    // other "Sign in" button) is NOT disabled - filter by the form's context.
    const submits = screen.getAllByRole('button', { name: 'Sign in' }) as HTMLButtonElement[];
    // With a short password, no submit should be enabled from the FORM;
    // header pill is always enabled. So exactly one enabled + one disabled.
    const enabled = submits.filter((b) => !b.disabled);
    const disabled = submits.filter((b) => b.disabled);
    expect(enabled).toHaveLength(1);
    expect(disabled.length).toBeGreaterThanOrEqual(1);
    // Confirm the disabled one is inside a form (i.e. is the form submit).
    const formSubmit = disabled.find((b) => b.closest('form') !== null);
    expect(formSubmit).toBeTruthy();
  });
});
