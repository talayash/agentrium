import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Mail } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../store/appStore';
import { ProgressStripe } from './ui/ProgressStripe';
import { ContactModal } from './ContactModal';

/**
 * Minimal status strip: app version + a "contact us" button. Everything else
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
      {/* Concentric Toolbar: no bar - one small glass capsule centred on
          the window's bottom edge. */}
      <div className="h-[var(--h-status)] flex items-center justify-center text-[11px] select-none">
        <div className="glass-capsule h-5 pr-2">
          <button
            type="button"
            onClick={() => setContactOpen(true)}
            aria-label="Send feedback or contact us"
            title="Contact us"
            className="inline-flex items-center gap-1 h-4 px-1.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors duration-100"
          >
            <Mail size={11} />
            <span>Contact</span>
          </button>
          {appVersion && (
            <span className="text-text-tertiary font-mono ml-0.5">v{appVersion}</span>
          )}
        </div>
      </div>
      <AnimatePresence>
        {contactOpen && <ContactModal onClose={() => setContactOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
