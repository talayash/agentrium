import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../store/appStore';
import { ProgressStripe } from './ui/ProgressStripe';

/**
 * Minimal status strip: just the app version (everything else moved to where
 * it belongs - notifications to the titlebar, session/branch state to the
 * session header and sidebar cards). The indeterminate ProgressStripe still
 * rides on top while a global background task runs.
 */
export function StatusBar() {
  const globalBusy = useAppStore((s) => s.globalBusy);
  const [appVersion, setAppVersion] = useState('');

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
      <div className="h-[var(--h-status)] flex items-center justify-end px-2 material-chrome border-t border-seam-strong text-[11px] select-none">
        {appVersion && (
          <span className="text-text-tertiary font-mono">v{appVersion}</span>
        )}
      </div>
    </div>
  );
}
