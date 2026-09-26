import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { payload: unknown }) => void | Promise<void>;
const handlers = new Map<string, Handler>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

import { logout, subscribeToAuthEvents } from './auth';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { useToastStore } from '../store/toastStore';

beforeEach(() => {
  handlers.clear();
  useAuthStore.getState().setUnknown();
  useAuthStore.getState().setAuthError(null);
  useToastStore.getState().clearAll();
});

describe('subscribeToAuthEvents', () => {
  it('routes the Rust auth-error event into the auth store and a toast', async () => {
    await subscribeToAuthEvents();
    const onError = handlers.get('auth-error');
    expect(onError, 'must subscribe to auth-error').toBeDefined();

    await onError!({ payload: 'token exchange rejected (400): invalid_grant' });

    expect(useAuthStore.getState().authError).toBe('token exchange rejected (400): invalid_grant');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toContain('invalid_grant');
  });

  it('still subscribes to auth-tokens-received', async () => {
    await subscribeToAuthEvents();
    expect(handlers.get('auth-tokens-received')).toBeDefined();
  });

  it('unsubscribes both listeners', async () => {
    const unlisten = await subscribeToAuthEvents();
    unlisten();
    expect(handlers.size).toBe(0);
  });
});

describe('logout', () => {
  const user = { id: 'u1', email: 'a@b.c', name: null, image: null };

  it('clears the signed-in state quietly when everything succeeded', async () => {
    useAuthStore.getState().setAuthed(user, 'AT');
    vi.mocked(invoke).mockResolvedValueOnce({ server_revoked: true, local_error: null });
    await logout();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps the user signed in when the saved session could not be removed', async () => {
    useAuthStore.getState().setAuthed(user, 'AT');
    vi.mocked(invoke).mockRejectedValueOnce("Couldn't remove your saved sign-in from the system keychain (denied)");
    await logout();
    expect(useAuthStore.getState().mode).toBe('authed');
    const [t] = useToastStore.getState().toasts;
    expect(t.type).toBe('error');
    expect(t.message).toContain('keychain');
  });

  it('warns when the keychain cleanup is deferred to next launch', async () => {
    useAuthStore.getState().setAuthed(user, 'AT');
    vi.mocked(invoke).mockResolvedValueOnce({ server_revoked: false, local_error: 'keyring delete: denied' });
    await logout();
    expect(useAuthStore.getState().mode).toBe('guest');
    const [t] = useToastStore.getState().toasts;
    expect(t.type).toBe('warning');
    expect(t.message).toContain('next launch');
  });
});
