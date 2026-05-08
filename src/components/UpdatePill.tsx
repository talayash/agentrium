import { motion, AnimatePresence } from 'framer-motion';
import { RotateCw, AlertTriangle } from 'lucide-react';
import { useUpdaterStore } from '../store/updaterStore';

export function UpdatePill() {
  const { status, updateInfo, error, restart, checkForUpdates } = useUpdaterStore();

  if (status !== 'ready' && status !== 'error') {
    return null;
  }

  if (status === 'error') {
    return (
      <button
        onClick={() => void checkForUpdates()}
        title={error || 'Update failed — click to retry'}
        className="no-drag flex items-center gap-1.5 h-6 px-2 rounded-full bg-error/15 text-error ring-1 ring-inset ring-error/30 hover:bg-error/20 transition-colors text-[11px] font-medium max-w-[180px]"
      >
        <AlertTriangle size={11} strokeWidth={2} className="flex-shrink-0" />
        <span className="truncate">Update failed</span>
      </button>
    );
  }

  // status === 'ready'
  const version = updateInfo?.version ?? '';

  return (
    <AnimatePresence>
      <motion.button
        key="update-pill-ready"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: [0.9, 1.05, 1] }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.6, times: [0, 0.5, 1] }}
        onClick={() => void restart()}
        title={`Restart to install update v${version} — your terminals will be restored`}
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
