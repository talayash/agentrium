import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/auth', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

// LoginModal pulls in tauri-api indirectly via lib/auth; that mock covers it.
// The errorReporter is silenced so a stray sign-out failure in a test doesn't
// try to invoke Tauri.
vi.mock('../lib/errorReporter', () => ({
  reportInvokeFailure: vi.fn(),
}));

import { HeaderAuth } from './HeaderAuth';
import { useAuthStore } from '../store/authStore';

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setUnknown();
});
// Vitest globals is off, so testing-library skips auto-cleanup - matches the
// pattern in LoginModal.test.tsx / AddApiKeyModal.test.tsx.
afterEach(() => cleanup());

describe('HeaderAuth', () => {
  it('renders nothing when mode is unknown', () => {
    const { container } = render(<HeaderAuth />);
    expect(container.firstChild).toBeNull();
  });

  it('renders Sign in button when mode is guest', () => {
    useAuthStore.getState().setGuest();
    render(<HeaderAuth />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
  });

  it('renders user name when authed', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    render(<HeaderAuth />);
    expect(screen.getByText('Tal Ayash')).toBeTruthy();
  });

  it('opens dropdown menu on click', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    render(<HeaderAuth />);
    fireEvent.click(screen.getByRole('button', { name: /tal ayash/i }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeTruthy();
  });
});
