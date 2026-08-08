import { motion, AnimatePresence } from 'framer-motion';
import { RotateCw, AlertTriangle, Download } from 'lucide-react';
import { useUpdaterStore } from '../store/updaterStore';
import { Tooltip } from './ui/Tooltip';

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
      <Tooltip label={error || 'Update failed - click to retry'}>
        <button
          onClick={() => void checkForUpdates()}
          className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-error/15 text-error ring-1 ring-inset ring-error/30 hover:bg-error/20 transition-colors text-[11px] font-medium max-w-[180px]"
        >
          <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0" />
          <span className="truncate">Update failed</span>
        </button>
      </Tooltip>
    );
  }

  const version = updateInfo?.version ?? '';

  if (status === 'available') {
    // Clicking the pill clears any "Later"/snooze and kicks off the download
    // so a user who dismissed the banner can still update on demand.
    return (
      <AnimatePresence>
        <Tooltip label={`Update available - v${version}. Click to download & install.`}>
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
          className="no-drag flex items-center gap-1.5 h-6 px-2.5 rounded-full text-white text-[11px] font-medium max-w-[180px] transition-all hover:brightness-110"
          style={{
            background: 'linear-gradient(180deg, var(--accent-secondary), var(--accent-primary))',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
          }}
        >
          <Download size={11} strokeWidth={2.25} className="flex-shrink-0" />
          <span className="truncate">
            Update <span className="opacity-80">·</span> v{version}
          </span>
        </motion.button>
        </Tooltip>
      </AnimatePresence>
    );
  }

  // status === 'ready'

  return (
    <AnimatePresence>
      <Tooltip label={`Restart to install update v${version} - your terminals will be restored`}>
      <motion.button
        key="update-pill-ready"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: [0.9, 1.05, 1] }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.6, times: [0, 0.5, 1] }}
        onClick={() => void restart()}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-accent-primary/15 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <RotateCw size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">
          Relaunch <span className="opacity-70">·</span> v{version}
        </span>
      </motion.button>
      </Tooltip>
    </AnimatePresence>
  );
}
