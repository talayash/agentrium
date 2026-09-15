import { beforeEach, describe, expect, it } from 'vitest';
import { applyRehydrateOutcome } from './rehydrate';
import { useAuthStore } from '../store/authStore';

const user = { id: 'u1', email: 'u1@example.com', name: 'U1', image: null };

beforeEach(() => {
  useAuthStore.getState().setUnknown();
});

describe('applyRehydrateOutcome', () => {
  it('signed_in hydrates the store with the token and reports signed in', () => {
    const signedIn = applyRehydrateOutcome({ kind: 'signed_in', access_token: 'tok', user });
    expect(signedIn).toBe(true);
    const s = useAuthStore.getState();
    expect(s.mode).toBe('authed');
    expect(s.user).toEqual(user);
    expect(s.accessToken).toBe('tok');
    expect(s.offline).toBe(false);
  });

  it('unavailable with a cached user keeps the account signed in, offline, with no access token', () => {
    const signedIn = applyRehydrateOutcome({ kind: 'unavailable', error: 'network: offline', user });
    expect(signedIn).toBe(true);
    const s = useAuthStore.getState();
    expect(s.mode).toBe('authed');
    expect(s.user).toEqual(user);
    expect(s.accessToken).toBeNull();
    expect(s.offline).toBe(true);
  });

  it('unavailable without a cached user leaves the store untouched and reports not signed in', () => {
    const signedIn = applyRehydrateOutcome({ kind: 'unavailable', error: 'network: offline', user: null });
    expect(signedIn).toBe(false);
    expect(useAuthStore.getState().mode).toBe('unknown');
  });

  it('no_session reports not signed in', () => {
    expect(applyRehydrateOutcome({ kind: 'no_session' })).toBe(false);
    expect(useAuthStore.getState().mode).toBe('unknown');
  });

  it('a later online sign-in clears the offline flag', () => {
    applyRehydrateOutcome({ kind: 'unavailable', error: 'network: offline', user });
    useAuthStore.getState().setAuthed(user, 'tok');
    expect(useAuthStore.getState().offline).toBe(false);
  });
});
