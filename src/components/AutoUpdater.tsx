import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { AlertTriangle, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUpdaterStore } from '../store/updaterStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { formatBytes } from '../lib/formatBytes';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import appIcon from '../assets/app-icon.png';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const RELEASES_URL = 'https://github.com/talayash/agentrium/releases/latest';

/** App mark for the alert. Alerts in macOS lead with the application's icon at
 *  ~64pt, with a small status badge for a non-neutral outcome. */
function AppMark({ badge }: { badge?: 'ready' | 'failed' }) {
  return (
    <div className="relative h-16 w-16">
      <img
        src={appIcon}
        alt=""
        draggable={false}
        className={`h-16 w-16 ${badge === 'failed' ? 'saturate-50 brightness-75' : ''}`}
      />
      {badge && (
        <div
          className={`absolute -bottom-1 -right-1 flex h-[25px] w-[25px] items-center justify-center rounded-full ring-[3.5px] ring-[var(--material-sheet-bg)] ${
            badge === 'ready' ? 'bg-success' : 'bg-warning'
          }`}
        >
          {badge === 'ready' ? (
            <Check size={14} strokeWidth={3.2} className="text-elevation-0" />
          ) : (
            <AlertTriangle size={13} strokeWidth={2.6} className="text-elevation-0" />
          )}
        </div>
      )}
    </div>
  );
}

export function AutoUpdater() {
  const {
    status,
    updateInfo,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    error,
    bannerDismissedVersion,
    bannerSnoozedUntil,
    notifiedVersion,
    skippedVersion,
    checkForUpdates,
    downloadAndInstall,
    restart,
    dismissBanner,
    snoozeBanner,
    skipVersion,
    markNotified,
  } = useUpdaterStore();
  const [now, setNow] = useState(() => Date.now());
  const [optionHeld, setOptionHeld] = useState(false);

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

  // When a snooze is active, tick once after it expires so the sheet reappears.
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

  // Option reveals the snooze variant of "Later" in place, the macOS pattern
  // for a hidden alternative to a visible button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setOptionHeld(e.altKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  // Fire a desktop toast once per detected version so users see the update
  // even if the app is minimized/backgrounded.
  useEffect(() => {
    if (status !== 'available' || !updateInfo) return;
    if (notifiedVersion === updateInfo.version) return;
    void invoke('send_notification', {
      title: 'Agentrium update available',
      body: `Version ${updateInfo.version} is ready to install. Open the app to update.`,
    }).catch((err) => {
      // Notification failures are non-fatal - the in-app sheet still shows.
      // We still report so we know if the OS notification path is broken.
      reportInvokeFailure('send_notification', err);
    });
    markNotified(updateInfo.version);
  }, [status, updateInfo, notifiedVersion, markNotified]);

  const snoozeActive = bannerSnoozedUntil !== null && now < bannerSnoozedUntil;
  const dismissedForCurrent =
    updateInfo !== null && bannerDismissedVersion === updateInfo.version;
  const skippedForCurrent = updateInfo !== null && skippedVersion === updateInfo.version;

  // An `error` with no updateInfo is a failed background *check* - that is the
  // pill's job, not an alert's. Only a failure against a known update earns a
  // sheet, because that one interrupted something the user asked for.
  const sheetEligible =
    status === 'available' ||
    status === 'downloading' ||
    status === 'ready' ||
    status === 'error';

  const showSheet =
    sheetEligible &&
    updateInfo !== null &&
    !dismissedForCurrent &&
    !snoozeActive &&
    !skippedForCurrent;

  // Escape is always the safe out, and the safe out is "ask me again next
  // launch" - never the irreversible skip.
  const handleLater = () => dismissBanner();

  const handleLaterClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.altKey) snoozeBanner(FOUR_HOURS_MS);
    else dismissBanner();
  };

  return (
    <AnimatePresence>
      {showSheet && updateInfo && (
        <Modal
          key="update-sheet"
          onClose={handleLater}
          closeOn="none"
          panelClassName="w-[440px]"
          scrimClassName="bg-black/45 z-[90]"
        >
          <div className="flex flex-col items-center px-[26px] pb-5 pt-[30px]">
            {status === 'available' && (
              <>
                <AppMark />
                <h2 className="mt-[19px] text-center text-[17px] font-semibold tracking-title text-text-primary">
                  A new version is available
                </h2>
                <p className="mt-2 text-center text-[12px] font-medium tabular-nums text-text-secondary">
                  Agentrium {updateInfo.version}
                  {updateInfo.date ? ` · ${updateInfo.date}` : ''}
                </p>

                {updateInfo.body && (
                  <div className="relative mt-5 w-full">
                    <div className="max-h-44 overflow-y-auto whitespace-pre-line rounded-lg bg-elevation-2 px-4 pb-[18px] pt-3.5 text-left text-[12px] leading-relaxed text-text-secondary shadow-[inset_0_0_0_1px_var(--seam)]">
                      {updateInfo.body}
                    </div>
                    {/* The notes scroll; fade the cut so it reads as "more below"
                        rather than a sentence that stops mid-air. */}
                    <div className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-lg bg-gradient-to-b from-transparent to-elevation-2" />
                  </div>
                )}

                <div className="mt-5 flex w-full items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={skipVersion}>
                    Skip This Version
                  </Button>
                  <div className="flex-grow" />
                  <Button variant="secondary" size="sm" onClick={handleLaterClick}>
                    {optionHeld ? 'Remind Me Later' : 'Later'}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void downloadAndInstall()}>
                    Update
                  </Button>
                </div>
              </>
            )}

            {status === 'downloading' && (
              <>
                <AppMark />
                <h2 className="mt-[19px] text-center text-[17px] font-semibold tracking-title text-text-primary">
                  Downloading Agentrium {updateInfo.version}
                </h2>

                <div
                  role="progressbar"
                  aria-label="Download progress"
                  aria-valuenow={downloadProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="mt-[22px] h-1 w-full overflow-hidden rounded-full bg-fill-hover"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent-secondary to-accent-primary transition-[width] duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>

                <p className="mt-3 text-center text-[11px] tabular-nums text-text-tertiary">
                  {totalBytes > 0
                    ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`
                    : `${downloadProgress}%`}
                </p>

                <div className="mt-[22px] flex w-full justify-end">
                  {/* No Cancel: the updater plugin has no abort. Offering one would
                      be a lie, so the honest affordance is to get out of the way. */}
                  <Button variant="secondary" size="sm" onClick={dismissBanner}>
                    Continue in Background
                  </Button>
                </div>
              </>
            )}

            {status === 'ready' && (
              <>
                <AppMark badge="ready" />
                <h2 className="mt-[19px] text-center text-[17px] font-semibold tracking-title text-text-primary">
                  Agentrium {updateInfo.version} is ready
                </h2>
                <p className="mt-2 max-w-[320px] text-center text-[12px] leading-relaxed text-text-secondary">
                  Your terminals, layout and scrollback will be restored after the relaunch.
                </p>

                <div className="mt-6 flex w-full items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={dismissBanner}>
                    Install on Quit
                  </Button>
                  <div className="flex-grow" />
                  <Button variant="primary" size="sm" onClick={() => void restart()}>
                    Relaunch and Install
                  </Button>
                </div>
              </>
            )}

            {status === 'error' && (
              <>
                <AppMark badge="failed" />
                <h2 className="mt-[19px] text-center text-[17px] font-semibold tracking-title text-text-primary">
                  The update could not be downloaded
                </h2>
                <p className="mt-2 max-w-[330px] text-center text-[12px] leading-relaxed text-text-secondary">
                  Check your connection and try again, or download the installer from the release page.
                </p>

                {error && (
                  <details className="mt-4 w-full">
                    <summary className="cursor-pointer list-none py-1 text-[11.5px] font-medium text-text-tertiary">
                      Show details
                    </summary>
                    <div className="mt-2 break-words rounded-lg bg-elevation-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-text-secondary shadow-[inset_0_0_0_1px_var(--seam)]">
                      {error}
                    </div>
                  </details>
                )}

                <div className="mt-[22px] flex w-full items-center gap-2">
                  <a
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    Download Manually
                  </a>
                  <div className="flex-grow" />
                  <Button variant="primary" size="sm" onClick={() => void downloadAndInstall()}>
                    Try Again
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
}
