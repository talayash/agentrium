import { motion, AnimatePresence } from 'framer-motion';
import { RotateCw, AlertTriangle, Download } from 'lucide-react';
import { useUpdaterStore } from '../store/updaterStore';

export function UpdatePill() {
  const {
    status,
    updateInfo,
    error,
    restart,
    checkForUpdates,
    downloadAndInstall,
  } = useUpdaterStore();

  if (status !== 'ready' && status !== 'error' && status !== 'available') {
    return null;
  }

  if (status === 'error') {
    return (
      <button
        onClick={() => void checkForUpdates()}
        title={error || 'Update failed - click to retry'}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-error/15 text-error ring-1 ring-inset ring-error/30 hover:bg-error/20 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">Update failed</span>
      </button>
    );
  }

  const version = updateInfo?.version ?? '';

  if (status === 'available') {
    // Clicking the pill clears any "Later"/snooze and kicks off the download
    // so a user who dismissed the banner can still update on demand.
    return (
      <AnimatePresence>
        <motion.button
          key="update-pill-available"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: [0.9, 1.05, 1] }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.6, times: [0, 0.5, 1] }}
          onClick={() => {
            // Re-show the banner if it was dismissed/snoozed, then start the download.
            useUpdaterStore.setState({ bannerDismissedVersion: null, bannerSnoozedUntil: null });
            void downloadAndInstall();
          }}
          title={`Update available - v${version}. Click to download & install.`}
          className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-success/15 text-success ring-1 ring-inset ring-success/30 hover:bg-success/25 transition-colors text-[11px] font-medium max-w-[180px]"
        >
          <Download size={11} strokeWidth={2} className="flex-shrink-0" />
          <span className="truncate">
            Update <span className="opacity-70">·</span> v{version}
          </span>
        </motion.button>
      </AnimatePresence>
    );
  }

  // status === 'ready'

  return (
    <AnimatePresence>
      <motion.button
        key="update-pill-ready"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: [0.9, 1.05, 1] }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.6, times: [0, 0.5, 1] }}
        onClick={() => void restart()}
        title={`Restart to install update v${version} - your terminals will be restored`}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-accent-primary/15 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <RotateCw size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">
          Relaunch <span className="opacity-70">·</span> v{version}
        </span>
      </motion.button>
    </AnimatePresence>
  );
}
