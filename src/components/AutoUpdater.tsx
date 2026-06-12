import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, RefreshCw, X, Rocket, Clock } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUpdaterStore } from '../store/updaterStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { Button } from './ui/Button';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export function AutoUpdater() {
  const {
    status,
    updateInfo,
    downloadProgress,
    bannerDismissedVersion,
    bannerSnoozedUntil,
    notifiedVersion,
    checkForUpdates,
    downloadAndInstall,
    restart,
    dismissBanner,
    snoozeBanner,
    markNotified,
  } = useUpdaterStore();
  const [now, setNow] = useState(() => Date.now());

  // Check for updates on mount
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        await checkForUpdates();
      } catch {
        // Silently ignore update check failures on startup
      }
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  // Periodic background check so users who never relaunch still see updates.
  useEffect(() => {
    const id = setInterval(() => {
      const last = useUpdaterStore.getState().lastCheckAt;
      // Guard against drift on a sleeping/throttled timer - only fire if
      // at least 4h of wall-clock time have actually elapsed.
      if (last !== null && Date.now() - last < FOUR_HOURS_MS) return;
      void checkForUpdates();
    }, FOUR_HOURS_MS);
    return () => clearInterval(id);
  }, [checkForUpdates]);

  // Re-check when the window regains focus after a long idle, so a user
  // who minimized the app for hours/days sees updates immediately on return.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();

    win.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const last = useUpdaterStore.getState().lastCheckAt;
      if (last !== null && Date.now() - last < THIRTY_MINUTES_MS) return;
      void checkForUpdates();
    }).then((un) => { unlisten = un; });

    return () => {
      unlisten?.();
    };
  }, [checkForUpdates]);

  // When a snooze is active, tick once after it expires so the banner reappears.
  useEffect(() => {
    if (bannerSnoozedUntil === null) return;
    const remaining = bannerSnoozedUntil - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const id = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(id);
  }, [bannerSnoozedUntil]);

  // Fire a desktop toast once per detected version so users see the update
  // even if the app is minimized/backgrounded.
  useEffect(() => {
    if (status !== 'available' || !updateInfo) return;
    if (notifiedVersion === updateInfo.version) return;
    void invoke('send_notification', {
      title: 'ClaudeTerminal update available',
      body: `Version ${updateInfo.version} is ready to install. Open the app to update.`,
    }).catch((err) => {
      // Notification failures are non-fatal - the in-app banner still shows.
      // We still report so we know if the OS notification path is broken.
      reportInvokeFailure('send_notification', err);
    });
    markNotified(updateInfo.version);
  }, [status, updateInfo, notifiedVersion, markNotified]);

  const snoozeActive = bannerSnoozedUntil !== null && now < bannerSnoozedUntil;
  const dismissedForCurrent =
    updateInfo !== null && bannerDismissedVersion === updateInfo.version;

  const bannerEligible =
    status === 'available' || status === 'downloading' || status === 'ready';
  const showBanner = bannerEligible && !dismissedForCurrent && !snoozeActive;

  if (!showBanner) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -30 }}
        transition={{ duration: 0.15 }}
        className="fixed top-10 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4"
      >
        <div className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              {status === 'available' && <Download size={14} className="text-accent-primary" />}
              {status === 'downloading' && <RefreshCw size={14} className="text-accent-primary animate-spin" />}
              {status === 'ready' && <Rocket size={14} className="text-success" />}
              <span className="text-text-primary text-[13px] font-medium">
                {status === 'available' && `Update Available: v${updateInfo?.version}`}
                {status === 'downloading' && 'Downloading update...'}
                {status === 'ready' && 'Update Ready'}
              </span>
            </div>
            <button
              onClick={dismissBanner}
              title="Dismiss until next launch"
              className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          {/* Content */}
          <div className="p-3">
            {status === 'available' && updateInfo && (
              <div className="space-y-3">
                {updateInfo.body && (
                  <p className="text-text-tertiary text-[11px] line-clamp-3">
                    {updateInfo.body}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    icon={<Download size={14} />}
                    onClick={() => downloadAndInstall()}
                    className="flex-1 min-w-[140px]"
                  >
                    Update Now
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Clock size={12} />}
                    onClick={() => snoozeBanner(FOUR_HOURS_MS)}
                  >
                    Remind in 4h
                  </Button>
                  <Button variant="ghost" onClick={dismissBanner}>
                    Later
                  </Button>
                </div>
              </div>
            )}

            {status === 'downloading' && (
              <div className="space-y-2">
                <div className="flex justify-between text-[11px] text-text-tertiary">
                  <span>Downloading...</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div className="h-1 bg-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-primary transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {status === 'ready' && (
              <div className="space-y-3">
                <p className="text-text-secondary text-[12px]">
                  Update downloaded. Restart to apply.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={restart}
                    className="flex-1 flex items-center justify-center gap-2 bg-success hover:bg-success/90 text-white h-9 px-4 rounded-md text-[12px] font-medium transition-colors"
                  >
                    <Rocket size={14} />
                    Restart Now
                  </button>
                  <Button variant="ghost" onClick={dismissBanner}>
                    Later
                  </Button>
                </div>
              </div>
            )}

          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
