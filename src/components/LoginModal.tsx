import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import {
  startOAuthLogin,
  markAuthPromptSeen,
  signupCredentials,
  signinCredentials,
} from '../lib/auth';
import { useAuthStore } from '../store/authStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface LoginModalProps {
  onClose: () => void;
}

type OAuthProvider = 'google' | 'github';
type FormMode = 'signin' | 'signup';

/**
 * First-launch sign-in prompt. Offers Google + GitHub OAuth (M1), inline
 * email + password (M2b), or "continue as guest".
 *
 * OAuth buttons don't close the modal themselves: they kick off the browser
 * hop; when the deep-link handler fires `auth-tokens-received`, App.tsx
 * unmounts the modal.
 *
 * Email + password is entirely in-app (no browser hop). On success the Rust
 * IPC path fires `auth-tokens-received` too, so hydration is uniform.
 */
export function LoginModal({ onClose }: LoginModalProps) {
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyBusy = oauthBusy !== null || formBusy;

  const handleOAuth = async (provider: OAuthProvider) => {
    setOauthBusy(provider);
    setError(null);
    try {
      await startOAuthLogin(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOauthBusy(null);
      reportInvokeFailure('start_oauth_login', err);
    }
  };

  const handleGuest = async () => {
    try {
      await markAuthPromptSeen();
    } catch (err) {
      reportInvokeFailure('mark_auth_prompt_seen', err);
    }
    useAuthStore.getState().setGuest();
    onClose();
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFormBusy(true);
    try {
      if (formMode === 'signup') {
        await signupCredentials(email, password, name.trim() || undefined);
      } else {
        await signinCredentials(email, password);
      }
      // Success: the Rust IPC path stored the refresh token + fired
      // auth-tokens-received. App.tsx will unmount this modal when
      // authStore.mode flips to 'authed'.
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(userMessageFor(code, formMode));
      setFormBusy(false);
    }
  };

  const toggleFormMode = () => {
    setFormMode((m) => (m === 'signin' ? 'signup' : 'signin'));
    setError(null);
  };

  return (
    <Modal
      onClose={onClose}
      showHeader
      title="Sign in to Agentrium"
      panelClassName="w-full max-w-md"
    >
      <div className="p-5 space-y-3">
        <p className="text-[13px] text-text-secondary leading-relaxed pb-1">
          Sign in to sync your profiles, hints, and custom agents across your computers.
        </p>

        <button
          type="button"
          onClick={() => handleOAuth('google')}
          disabled={anyBusy}
          className="w-full h-10 px-4 flex items-center justify-center gap-3 rounded-md bg-white text-[#1f1f1f] text-[13px] font-medium ring-1 ring-black/10 hover:bg-[#f7f8f8] active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
        >
          {oauthBusy === 'google' ? (
            <Loader2 size={16} className="animate-spin text-[#1f1f1f]/60" />
          ) : (
            <GoogleG />
          )}
          <span>{oauthBusy === 'google' ? 'Opening browser…' : 'Sign in with Google'}</span>
        </button>

        <button
          type="button"
          onClick={() => handleOAuth('github')}
          disabled={anyBusy}
          className="w-full h-10 px-4 flex items-center justify-center gap-3 rounded-md bg-[#24292e] text-white text-[13px] font-medium hover:bg-[#32383f] active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
        >
          {oauthBusy === 'github' ? (
            <Loader2 size={16} className="animate-spin text-white/60" />
          ) : (
            <GitHubMark />
          )}
          <span>{oauthBusy === 'github' ? 'Opening browser…' : 'Sign in with GitHub'}</span>
        </button>

        {!formOpen && (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="w-full text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 pt-1 transition-colors"
          >
            Or use email + password
          </button>
        )}

        {formOpen && (
          <form onSubmit={handleFormSubmit} className="space-y-2 pt-1">
            <label className="block">
              <span className="text-[11px] text-text-tertiary">Email</span>
              <input
                type="email"
                autoComplete={formMode === 'signup' ? 'email' : 'username'}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={formBusy}
                className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-tertiary">Password</span>
              <input
                type="password"
                autoComplete={formMode === 'signup' ? 'new-password' : 'current-password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={formBusy}
                className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
              />
            </label>
            {formMode === 'signup' && (
              <label className="block">
                <span className="text-[11px] text-text-tertiary">Name (optional)</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={formBusy}
                  className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={anyBusy || email.length === 0 || password.length < 8}
              className="w-full h-10 px-4 flex items-center justify-center gap-2 rounded-md bg-accent-primary text-white text-[13px] font-medium hover:bg-accent-secondary active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
            >
              {formBusy && <Loader2 size={16} className="animate-spin" />}
              <span>
                {formBusy
                  ? formMode === 'signup'
                    ? 'Creating account…'
                    : 'Signing in…'
                  : formMode === 'signup'
                    ? 'Create account'
                    : 'Sign in'}
              </span>
            </button>
            <button
              type="button"
              onClick={toggleFormMode}
              disabled={formBusy}
              className="w-full text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 transition-colors disabled:opacity-50"
            >
              {formMode === 'signin'
                ? "Don't have an account? Create one"
                : 'Already have an account? Sign in'}
            </button>
          </form>
        )}

        {error && (
          <div
            role="alert"
            className="text-[12px] text-error bg-error/10 border border-error/30 rounded-md px-2.5 py-1.5"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center px-4 h-11 border-t border-[var(--seam)] bg-elevation-3">
        <button
          type="button"
          onClick={handleGuest}
          className="text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 transition-colors"
        >
          Continue as guest
        </button>
      </div>
    </Modal>
  );
}

/**
 * Map Rust error codes to user-visible messages. Codes come from the two
 * IPC commands' `error_reporter::user_err` calls in auth.rs.
 */
function userMessageFor(code: string, mode: FormMode): string {
  if (code.includes('email_taken')) {
    return 'That email is already registered. Try signing in instead.';
  }
  if (code.includes('invalid_credentials')) {
    return 'Wrong email or password.';
  }
  if (code.toLowerCase().includes('password')) {
    // Passes through the broker's "Password must be at least 8 characters" etc.
    return code;
  }
  if (code.toLowerCase().includes('network')) {
    return 'Could not reach the server. Check your connection.';
  }
  return mode === 'signup' ? 'Could not create account. Please try again.' : 'Could not sign in. Please try again.';
}

// Google + GitHub brand icons (unchanged from M1).

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  );
}
