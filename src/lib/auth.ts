import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAuthStore, type AuthUser } from '../store/authStore';
import { reportInvokeFailure } from './errorReporter';

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

/**
 * Sign out locally: clears the OS keychain refresh token, drops the cached
 * user id, and resets the in-memory authStore. Broker-side revocation is M3.
 *
 * The local `authStore.clear()` runs unconditionally (in `finally`) so a
 * transient Rust failure — keychain quirk, DB lock — can never leave the UI
 * stuck showing the authed chip. A stale keychain entry is less bad than
 * lying about the sign-in state; the next boot's rehydrate will either
 * silently drop it (if refresh 401s) or silently sign the user back in
 * (if the token is still valid, which is fine — they were signed in).
 */
export async function logout(): Promise<void> {
  try {
    await invoke('logout');
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
 * Attach the auth-tokens-received listener. Call once on app boot (Task 26).
 * Returns an unlisten function.
 *
 * When the deep-link handler emits fresh tokens, we exchange the access token
 * for the user profile and hydrate authStore. Failures here are reported via
 * errorReporter because there's no user-facing invoke site to catch them -
 * the OAuth flow completes in the browser, not in a component's try/catch.
 */
export async function subscribeToAuthEvents(): Promise<UnlistenFn> {
  return await listen<{ access_token: string; state: string }>(
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
}
