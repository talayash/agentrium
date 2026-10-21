import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Mail } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { ProgressStripe } from './ui/ProgressStripe';
import { ContactModal } from './ContactModal';
import { reportInvokeFailure } from '../lib/errorReporter';
import { toast } from '../store/toastStore';

// Permanent invite (set to never expire in Discord). Installed builds cannot be
// hot-fixed, so a revoked or expiring invite here breaks the button for good.
const DISCORD_INVITE_URL = 'https://discord.gg/NNDGeFE24s';

// Discord mark, path from simple-icons (CC0). viewBox 0 0 24 24, currentColor.
function DiscordMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

/**
 * Minimal status strip: app version + Discord and "contact us" buttons. Everything else
 * moved to where it belongs - notifications to the titlebar, session/branch
 * state to the session header and sidebar cards. The indeterminate
 * ProgressStripe still rides on top while a global background task runs.
 */
export function StatusBar() {
  const globalBusy = useAppStore((s) => s.globalBusy);
  const [appVersion, setAppVersion] = useState('');
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col shrink-0">
      {globalBusy && (
        <div title={globalBusy}>
          <ProgressStripe />
        </div>
      )}
      <div className="h-[var(--h-status)] flex items-center justify-end gap-1 px-2 material-chrome border-t border-seam-strong text-[11px] select-none">
        <button
          type="button"
          onClick={() => {
            invoke('open_external_url', { url: DISCORD_INVITE_URL }).catch((err) => {
              toast.error('Could not open Discord', String(err));
              reportInvokeFailure('open_external_url', err);
            });
          }}
          aria-label="Join the Agentrium Discord"
          title="Join our Discord"
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors duration-100"
        >
          <DiscordMark size={12} />
          <span>Discord</span>
        </button>
        <button
          type="button"
          onClick={() => setContactOpen(true)}
          aria-label="Send feedback or contact us"
          title="Contact us"
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors duration-100"
        >
          <Mail size={12} />
          <span>Contact</span>
        </button>
        {appVersion && (
          <span className="text-text-tertiary font-mono ml-1">v{appVersion}</span>
        )}
      </div>
      <AnimatePresence>
        {contactOpen && <ContactModal onClose={() => setContactOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
