import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.getState().setUnknown();
  });

  it('starts in unknown mode', () => {
    expect(useAuthStore.getState().mode).toBe('unknown');
  });

  it('setGuest transitions mode', () => {
    useAuthStore.getState().setGuest();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('setAuthed stores user + token', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'a@b.com', name: null, image: null },
      'jwt-token',
    );
    expect(useAuthStore.getState().mode).toBe('authed');
    expect(useAuthStore.getState().user?.email).toBe('a@b.com');
    expect(useAuthStore.getState().accessToken).toBe('jwt-token');
  });

  it('clear returns to guest mode', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'a@b.com', name: null, image: null },
      'jwt-token',
    );
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
