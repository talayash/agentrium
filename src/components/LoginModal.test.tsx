import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  useAuthStore.getState().setAuthError(null);
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

  // Regression: when the broker changed its callback contract, the Rust
  // deep-link handler failed silently and the modal spun on "Opening
  // browser…" forever. Rust now emits `auth-error`; the modal must react.
  it('stops spinning and shows the message when the Rust side reports auth-error', async () => {
    render(<LoginModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    await waitFor(() => expect(screen.getByText('Opening browser…')).toBeTruthy());

    act(() => {
      useAuthStore.getState().setAuthError('sign-in callback is missing code');
    });

    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeTruthy();
    expect(screen.queryByText('Opening browser…')).toBeNull();
    expect(screen.getByText(/sign-in callback is missing code/i)).toBeTruthy();
  });

  it('gives up on "Opening browser…" after the pending window and lets the user retry', async () => {
    vi.useFakeTimers();
    try {
      render(<LoginModal onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
      // startOAuthLogin resolves on a microtask; flush it under fake timers.
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Opening browser…')).toBeTruthy();

      act(() => { vi.advanceTimersByTime(3 * 60 * 1000); });

      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeTruthy();
      expect(screen.getByText(/timed out/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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
