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

/** Mirrors `auth::LogoutOutcome` in src-tauri/src/auth.rs. */
export interface LogoutOutcome {
  server_revoked: boolean;
  local_error: string | null;
}

/**
 * Sign out and tell the user exactly how far it got. A rejected invoke means
 * Rust could not remove the saved sign-in and could not neutralise it either,
 * so the session would come back on restart: keep the signed-in state instead
 * of showing a sign-out that did not happen.
 */
export async function logout(): Promise<void> {
  let outcome: LogoutOutcome;
  try {
    outcome = await invoke<LogoutOutcome>('logout');
  } catch (err) {
    toast.error('Sign-out failed', `${err instanceof Error ? err.message : String(err)}. Try signing out again.`);
    reportInvokeFailure('logout', err);
    return;
  }
  useAuthStore.getState().clear();
  if (!outcome.server_revoked) {
    toast.warning(
      'Signed out on this device',
      outcome.local_error
        ? 'Your saved sign-in could not be removed from the system keychain yet. Agentrium will finish removing it on next launch.'
        : 'Server sign-out could not be confirmed. The server session may remain valid until revoked or expired.',
    );
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
  const unlistenTokens = await listen<{ access_token: string; state: string; user?: AuthUser }>(
    'auth-tokens-received',
    async (event) => {
      const { access_token, user: verified } = event.payload;
      try {
        // Rust verified the account before starting the session and sends it
        // along; fetching /api/me a second time only added a way to fail.
        const user = verified ?? (await fetchCurrentUser(access_token));
        useAuthStore.getState().setAuthed(user, access_token);
      } catch (err) {
        // The sign-in finished on the Rust side, but the UI could not learn
        // who signed in. Surface it so LoginModal stops spinning, instead of
        // leaving it on "Opening browser..." until it times out.
        const message = err instanceof Error ? err.message : String(err);
        useAuthStore.getState().setAuthError(message);
        toast.error('Sign-in failed', message);
        reportInvokeFailure('auth_tokens_received_handler', err);
        return;
      }
      // Cosmetic flag; a failure here must not undo a successful sign-in.
      await markAuthPromptSeen().catch((err) => reportInvokeFailure('mark_auth_prompt_seen', err));
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
