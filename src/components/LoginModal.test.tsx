import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
  markAuthPromptSeen: vi.fn().mockResolvedValue(undefined),
}));

// The Modal shell calls reportInvokeFailure only from our handlers, but we
// still mock the module so a stray call in a test doesn't try to invoke Tauri.
vi.mock('../lib/errorReporter', () => ({
  reportInvokeFailure: vi.fn(),
}));

import { LoginModal } from './LoginModal';
import { useAuthStore } from '../store/authStore';
import { startOAuthLogin, markAuthPromptSeen } from '../lib/auth';

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setUnknown();
});
// Vitest globals is off, so testing-library skips auto-cleanup - the exit
// animation of Modal (opacity:0) would leave a duplicate copy in the DOM for
// the next test and every getBy* would collide. Matches the pattern used in
// AddApiKeyModal.test.tsx.
afterEach(() => cleanup());

describe('LoginModal', () => {
  it('renders sign-in options', () => {
    render(<LoginModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: /sign in to agentrium/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeTruthy();
  });

  it('calls startOAuthLogin("google") on Google click', async () => {
    render(<LoginModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    await waitFor(() => expect(startOAuthLogin).toHaveBeenCalledWith('google'));
  });

  it('marks guest and closes on Continue as guest', async () => {
    const onClose = vi.fn();
    render(<LoginModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }));
    await waitFor(() => expect(markAuthPromptSeen).toHaveBeenCalled());
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(onClose).toHaveBeenCalled();
  });
});
