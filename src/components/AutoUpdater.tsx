import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, RefreshCw, CheckCircle, AlertCircle, X, Rocket, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useUpdaterStore } from '../store/updaterStore';

const RELEASES_URL = 'https://github.com/talayash/claude-terminal/releases/latest';

export function AutoUpdater() {
  const { status, updateInfo, downloadProgress, error, checkForUpdates, downloadAndInstall, restart } = useUpdaterStore();
  const [showBanner, setShowBanner] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Check for updates on mount
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        await checkForUpdates();
        // Banner will auto-open via the ready-watcher effect once the
        // background download completes.
      } catch {
        // Silently ignore update check failures on startup
      }
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  // Show banner when update is downloaded and ready to install
  useEffect(() => {
    if (status === 'ready' && !dismissed) {
      setShowBanner(true);
    }
  }, [status, dismissed]);

  const dismissBanner = () => {
    setDismissed(true);
    setShowBanner(false);
  };

  // Don't show anything if dismissed or no banner needed
  if (!showBanner || dismissed) {
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
        <div className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              {status === 'checking' && <RefreshCw size={14} className="text-text-secondary animate-spin" />}
              {status === 'available' && <Download size={14} className="text-accent-primary" />}
              {status === 'downloading' && <RefreshCw size={14} className="text-accent-primary animate-spin" />}
              {status === 'ready' && <Rocket size={14} className="text-success" />}
              {status === 'up-to-date' && <CheckCircle size={14} className="text-success" />}
              {status === 'error' && <AlertCircle size={14} className="text-error" />}
              <span className="text-text-primary text-[13px] font-medium">
                {status === 'checking' && 'Checking for updates...'}
                {status === 'available' && `Update Available: v${updateInfo?.version}`}
                {status === 'downloading' && 'Downloading update...'}
                {status === 'ready' && 'Update Ready'}
                {status === 'up-to-date' && 'Up to date'}
                {status === 'error' && 'Update Error'}
              </span>
            </div>
            <button
              onClick={dismissBanner}
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
                <div className="flex gap-2">
                  <button
                    onClick={() => downloadAndInstall()}
                    className="flex-1 flex items-center justify-center gap-2 bg-accent-primary hover:bg-accent-secondary text-white h-9 px-4 rounded-md text-[12px] font-medium transition-colors"
                  >
                    <Download size={14} />
                    Download & Install
                  </button>
                  <button
                    onClick={dismissBanner}
                    className="px-4 h-9 text-text-secondary hover:text-text-primary hover:bg-white/[0.04] rounded-md text-[12px] transition-colors"
                  >
                    Later
                  </button>
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
                  <button
                    onClick={dismissBanner}
                    className="px-4 h-9 text-text-secondary hover:text-text-primary hover:bg-white/[0.04] rounded-md text-[12px] transition-colors"
                  >
                    Later
                  </button>
                </div>
              </div>
            )}

            {status === 'error' && (
              <div className="space-y-2">
                <p className="text-error text-[11px]">
                  {error || 'An error occurred while checking for updates.'}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => checkForUpdates()}
                    className="flex items-center gap-2 text-text-secondary hover:text-text-primary text-[12px] transition-colors"
                  >
                    <RefreshCw size={12} />
                    Try Again
                  </button>
                  <button
                    onClick={() => invoke('open_external_url', { url: RELEASES_URL })}
                    className="flex items-center gap-2 text-accent-primary hover:text-accent-secondary text-[12px] transition-colors"
                  >
                    <ExternalLink size={12} />
                    Download Manually
                  </button>
                </div>
              </div>
            )}

            {status === 'up-to-date' && (
              <p className="text-text-tertiary text-[12px]">
                You're running the latest version of ClaudeTerminal.
              </p>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
