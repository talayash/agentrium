import { create } from 'zustand';

export type AuthMode = 'unknown' | 'guest' | 'authed';

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type AuthState = {
  mode: AuthMode;
  user: AuthUser | null;
  accessToken: string | null; // in-memory only, never persisted
  setGuest: () => void;
  setAuthed: (user: AuthUser, accessToken: string) => void;
  setUnknown: () => void;
  clear: () => void;
};

/**
 * Auth state for Agentrium's sign-in flow (M1).
 *
 * Deliberately NOT persisted via zustand/middleware/persist. Access tokens
 * live only in memory here; refresh tokens live only in the OS keychain (via
 * credentials::SecretStore in Rust). Nothing auth-related touches localStorage.
 *
 * On app boot, App.tsx calls `rehydrate_auth` (Task 26) to trade the keychain
 * refresh token for a fresh access token and hydrate this store.
 */
export const useAuthStore = create<AuthState>((set) => ({
  mode: 'unknown',
  user: null,
  accessToken: null,
  setGuest: () => set({ mode: 'guest', user: null, accessToken: null }),
  setAuthed: (user, accessToken) => set({ mode: 'authed', user, accessToken }),
  setUnknown: () => set({ mode: 'unknown', user: null, accessToken: null }),
  clear: () => set({ mode: 'guest', user: null, accessToken: null }),
}));
