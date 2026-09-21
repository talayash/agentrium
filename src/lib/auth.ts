import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAuthStore, type AuthUser } from '../store/authStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from './errorReporter';
import type { RehydrateOutcome } from './rehydrate';

/**
 * Frontend wrappers over the Rust auth commands (see src-tauri/src/auth.rs).
 *
 * Kept thin: callers (LoginModal, HeaderAuth, App.tsx) handle their own toasts
 * and errorReporter calls at the invoke site, matching how save_profile /
 * delete_profile are called in ProfileModal.tsx. The one exception is the
 * background auth-tokens-received listener, which has no user-facing invoke
 * site to attach a toast to - it reports failures via reportInvokeFailure
 * because the OAuth flow that triggered it *is* user-initiated.
 */

/**
 * Kick off an OAuth sign-in. Opens the system browser at the broker start URL;
 * the flow completes when the OS deep-links `agentrium://auth-return?...` back
 * to us, which emits `auth-tokens-received` (see subscribeToAuthEvents).
 *
 * Email + password is deferred to M2 (spec §6.2).
 */
export async function startOAuthLogin(provider: 'google' | 'github'): Promise<void> {
  await invoke<{ opened_url: string }>('start_oauth_login', { provider });
}

/**
 * Register a new email+password account. On success the deep-link-equivalent
 * event fires from Rust and the store hydrates automatically. Throws with a
 * short error code on failure — LoginModal maps to user-friendly text.
 * Codes: 'email_taken' (409), 'invalid_password' (weak), or a generic string.
 */
export async function signupCredentials(
  email: string,
  password: string,
  name?: string,
): Promise<void> {
  await invoke('signup_credentials', { email, password, name });
}

/**
 * Sign in with email + password. Same hydration path as OAuth. Throws with
 * 'invalid_credentials' on wrong email/password (constant response — no user
 * enumeration).
 */
export async function signinCredentials(
  email: string,
  password: string,
): Promise<void> {
  await invoke('signin_credentials', { email, password });
}

/** Record that we've shown the "sign in to sync" prompt to this user. */
export async function markAuthPromptSeen(): Promise<void> {
  await invoke('mark_auth_prompt_seen');
}

/** Whether the "sign in to sync" prompt has been shown before. */
export async function getAuthPromptSeen(): Promise<boolean> {
  return await invoke<boolean>('get_auth_prompt_seen');
}

/** Clear local state and report whether server revocation succeeded. */
export async function logout(): Promise<void> {
  try {
    const revoked = await invoke<boolean>('logout');
    if (revoked === false) toast.warning('Signed out on this device', 'Server sign-out could not be confirmed. The server session may remain valid until revoked or expired.');
  } catch (err) {
    // Surface for telemetry but don't rethrow — we still want to clear the
    // frontend state so the user sees the sign-out take effect visually.
    reportInvokeFailure('logout', err);
  } finally {
    useAuthStore.getState().clear();
  }
}

/**
 * Fetch the currently-signed-in user from the broker `/api/me`. The access
 * token is short-lived and passed per-call; refresh lives only in the keychain.
 */
export async function fetchCurrentUser(accessToken: string): Promise<AuthUser> {
  return await invoke<AuthUser>('fetch_current_user', { accessToken });
}

/**
 * Boot-time refresh. Rust swaps the keychain refresh token for an access
 * token and reports what it found; see `applyRehydrateOutcome` for how each
 * outcome maps onto authStore.
 */
export async function rehydrateAuth(): Promise<RehydrateOutcome> {
  return await invoke<RehydrateOutcome>('rehydrate_auth');
}

/**
 * Attach the auth event listeners. Call once on app boot (Task 26).
 * Returns an unlisten function covering both subscriptions.
 *
 * `auth-tokens-received`: the deep-link handler (or the email+password IPC
 * path) finished a sign-in. Exchange the access token for the user profile
 * and hydrate authStore. Failures here are reported via errorReporter
 * because there's no user-facing invoke site to catch them - the OAuth flow
 * completes in the browser, not in a component's try/catch.
 *
 * `auth-error`: the Rust side could not finish a sign-in that was started
 * from the LoginModal (bad callback, expired state, token exchange rejected).
 * Without this listener the modal would spin on "Opening browser…" forever,
 * which is exactly what happened when the broker's callback contract changed.
 */
export async function subscribeToAuthEvents(): Promise<UnlistenFn> {
  const unlistenTokens = await listen<{ access_token: string; state: string }>(
    'auth-tokens-received',
    async (event) => {
      const { access_token } = event.payload;
      try {
        const user = await fetchCurrentUser(access_token);
        useAuthStore.getState().setAuthed(user, access_token);
        await markAuthPromptSeen();
      } catch (err) {
        // Background handler: no toast target, but the OAuth flow is
        // user-initiated so a silent failure would hide a real bug.
        reportInvokeFailure('auth_tokens_received_handler', err);
      }
    },
  );
  const unlistenError = await listen<string>('auth-error', (event) => {
    const message = typeof event.payload === 'string' ? event.payload : String(event.payload);
    useAuthStore.getState().setAuthError(message);
    // Rust already reported this to telemetry (report_bg); here we only
    // make it visible.
    toast.error('Sign-in failed', message);
  });
  return () => {
    unlistenTokens();
    unlistenError();
  };
}
