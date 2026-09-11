import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { startOAuthLogin, markAuthPromptSeen } from '../lib/auth';
import { useAuthStore } from '../store/authStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface LoginModalProps {
  onClose: () => void;
}

/**
 * First-launch sign-in prompt. Offers Google OAuth (M1) or "continue as guest".
 *
 * The Google button doesn't close the modal itself: it kicks off the OAuth
 * flow in the system browser and stays in "Opening browser…" state. When the
 * deep-link handler fires `auth-tokens-received`, `subscribeToAuthEvents`
 * (see `lib/auth.ts`) transitions authStore to `authed` and App.tsx unmounts
 * this modal. Guest, by contrast, is a synchronous local choice - we mark the
 * prompt seen so we don't nag on next launch, flip the store, and close.
 */
export function LoginModal({ onClose }: LoginModalProps) {
  const [busy, setBusy] = useState<'google' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGoogle = async () => {
    setBusy('google');
    setError(null);
    try {
      await startOAuthLogin('google');
      // Modal stays open until auth-tokens-received fires and authStore
      // transitions to 'authed'; App.tsx watches the store and unmounts us.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setBusy(null);
      reportInvokeFailure('start_oauth_login', err);
    }
  };

  const handleGuest = async () => {
    try {
      await markAuthPromptSeen();
    } catch (err) {
      // Best-effort: if the flag fails to persist, we'll re-show this modal
      // on next launch, which is annoying but not broken. Still worth
      // reporting because the OAuth flow is user-initiated.
      reportInvokeFailure('mark_auth_prompt_seen', err);
    }
    useAuthStore.getState().setGuest();
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      showHeader
      title="Sign in to Agentrium"
      icon={<LogIn size={14} className="text-accent-primary" />}
      panelClassName="w-full max-w-md"
    >
      <div className="p-5 space-y-4">
        <p className="text-[13px] text-text-secondary leading-relaxed">
          Sign in to sync your profiles, hints, and custom agents across your computers.
        </p>

        <Button
          variant="primary"
          size="md"
          onClick={handleGoogle}
          loading={busy === 'google'}
          disabled={busy !== null}
          className="w-full"
        >
          {busy === 'google' ? 'Opening browser…' : 'Sign in with Google'}
        </Button>

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
