import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/auth', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

// LoginModal pulls in tauri-api indirectly via lib/auth; that mock covers it.
// The errorReporter is silenced so a stray sign-out failure in a test doesn't
// try to invoke Tauri.
vi.mock('../lib/errorReporter', () => ({
  reportInvokeFailure: vi.fn(),
}));

vi.mock('../lib/sync', () => ({
  setSyncEnabled: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn().mockResolvedValue(undefined),
}));

import { HeaderAuth } from './HeaderAuth';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { syncNow } from '../lib/sync';

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

  it('shows initials instead of an image when image is null', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    render(<HeaderAuth />);
    expect(screen.getByText('TA')).toBeTruthy();
    expect(screen.queryByRole('img', { hidden: true })).toBeNull();
  });

  it('treats a blank image URL as missing (email+password users)', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: '   ' },
      'jwt',
    );
    render(<HeaderAuth />);
    expect(screen.getByText('TA')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to initials when the avatar image fails to load', () => {
    useAuthStore.getState().setAuthed(
      {
        id: 'u1',
        email: 'tal@example.com',
        name: 'Tal Ayash',
        image: 'https://example.invalid/avatar.png',
      },
      'jwt',
    );
    render(<HeaderAuth />);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(screen.queryByText('TA')).toBeNull();

    fireEvent.error(img!);

    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('TA')).toBeTruthy();
  });

  it('retries the image after a failure when the user switches to a new avatar URL', () => {
    useAuthStore.getState().setAuthed(
      {
        id: 'u1',
        email: 'tal@example.com',
        name: 'Tal Ayash',
        image: 'https://example.invalid/old.png',
      },
      'jwt',
    );
    render(<HeaderAuth />);
    fireEvent.error(document.querySelector('img')!);
    expect(screen.getByText('TA')).toBeTruthy();

    // Store updates outside a React event need act() so the re-render flushes
    // before we assert on the DOM.
    act(() => {
      useAuthStore.getState().setAuthed(
        {
          id: 'u1',
          email: 'tal@example.com',
          name: 'Tal Ayash',
          image: 'https://example.invalid/new.png',
        },
        'jwt',
      );
    });
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.invalid/new.png',
    );
  });

  it('offers a "Sync now" menu item that triggers an immediate sync and closes the menu', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    useSyncStore.setState({ enabled: true });
    render(<HeaderAuth />);
    fireEvent.click(screen.getByRole('button', { name: /tal ayash/i }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync now' }));

    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables "Sync now" while sync is paused', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    useSyncStore.setState({ enabled: false });
    render(<HeaderAuth />);
    fireEvent.click(screen.getByRole('button', { name: /tal ayash/i }));

    const item = screen.getByRole('menuitem', { name: 'Sync now' });
    expect(item).toHaveProperty('disabled', true);
    fireEvent.click(item);
    expect(syncNow).not.toHaveBeenCalled();
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
