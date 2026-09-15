import { useAuthStore, type AuthUser } from '../store/authStore';

/**
 * Wire shape of the Rust `rehydrate_auth` command (auth.rs `RehydrateOutcome`,
 * pinned there by `rehydrate_outcome_wire_shape`).
 */
export type RehydrateOutcome =
  | { kind: 'signed_in'; access_token: string; user: AuthUser }
  | { kind: 'no_session' }
  | { kind: 'unavailable'; error: string; user: AuthUser | null };

/**
 * Hydrate authStore from the boot-time refresh result. Returns true when the
 * user ends up signed in (online or offline), so App.tsx can skip the
 * first-launch prompt. Leaves the store untouched when nothing is known.
 *
 * `unavailable` with a user is the no-internet / broker-down launch: the
 * account stays signed in from local state and the sync chip shows Offline;
 * the Rust side already started the engine, which recovers on its own.
 */
export function applyRehydrateOutcome(outcome: RehydrateOutcome): boolean {
  switch (outcome.kind) {
    case 'signed_in':
      useAuthStore.getState().setAuthed(outcome.user, outcome.access_token);
      return true;
    case 'unavailable':
      if (!outcome.user) return false;
      console.warn('[auth] broker unavailable at boot, staying signed in offline:', outcome.error);
      useAuthStore.getState().setAuthedOffline(outcome.user);
      return true;
    case 'no_session':
      return false;
  }
}
