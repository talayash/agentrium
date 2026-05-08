import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Download, RefreshCw, CheckCircle, AlertCircle, ExternalLink, Check, Rocket } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../store/appStore';
import { useUpdaterStore } from '../store/updaterStore';
import { toast } from '../store/toastStore';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? 'Cmd' : 'Ctrl';

interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
}

export function SettingsModal() {
  const { closeSettings, defaultClaudeArgs, setDefaultClaudeArgs, notifyOnFinish, setNotifyOnFinish, restoreSession, setRestoreSession, telemetryEnabled, setTelemetryEnabled, errorReportingEnabled, setErrorReportingEnabled, showGitPanel, setShowGitPanel, showFileTree, setShowFileTree } = useAppStore();
  const [claudeVersion, setClaudeVersion] = useState<string>('');
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'success' | 'error' | 'uptodate'>('idle');
  const [updateMessage, setUpdateMessage] = useState<string>('');
  const [argsText, setArgsText] = useState(defaultClaudeArgs.join('\n'));

  // App version + auto-updater
  const [appVersion, setAppVersion] = useState<string>('');
  const appUpdater = useUpdaterStore();

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    checkForUpdates();
    appUpdater.checkForUpdates();
  }, []);

  const checkForUpdates = async () => {
    setIsChecking(true);
    setUpdateStatus('idle');
    setUpdateMessage('');
    try {
      const result = await invoke<UpdateCheckResult>('check_claude_update');
      setClaudeVersion(result.current_version);
      setLatestVersion(result.latest_version);
      setUpdateAvailable(result.update_available);
      if (!result.update_available) {
        setUpdateStatus('uptodate');
        setUpdateMessage('You have the latest version!');
      }
    } catch (error) {
      // Fallback to just getting version
      try {
        const version = await invoke<string>('get_claude_version');
        setClaudeVersion(version || 'Not installed');
      } catch {
        setClaudeVersion('Not installed');
      }
      setUpdateAvailable(null);
    }
    setIsChecking(false);
  };

  const handleUpdateClaude = async () => {
    if (updateAvailable === false) {
      setUpdateStatus('uptodate');
      setUpdateMessage('You already have the latest version!');
      return;
    }

    setIsUpdating(true);
    setUpdateStatus('idle');
    setUpdateMessage('Updating Claude Code...');
    try {
      const result = await invoke<string>('update_claude_code');
      setUpdateStatus('success');
      setUpdateMessage(result);
      toast.success('Claude Updated', result);
      // Re-check versions after update
      await checkForUpdates();
    } catch (error) {
      setUpdateStatus('error');
      setUpdateMessage(String(error));
      toast.error('Update Failed', String(error));
    }
    setIsUpdating(false);
  };

  const openDocs = async () => {
    await invoke('open_external_url', { url: 'https://docs.anthropic.com/en/docs/claude-code' });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
      onDoubleClick={closeSettings}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg shadow-2xl w-full max-w-lg overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-text-primary text-[14px] font-semibold">Settings</h2>
          <button
            onClick={closeSettings}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* App Updates */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">App Updates</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">ClaudeTerminal</p>
                  <p className="text-text-tertiary text-[11px]">v{appVersion}</p>
                  {appUpdater.status === 'available' && appUpdater.updateInfo && (
                    <p className="text-accent-primary text-[11px] mt-1">
                      Update available: v{appUpdater.updateInfo.version}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {appUpdater.status === 'up-to-date' ? (
                    <div className="flex items-center gap-2 bg-success/10 text-success h-9 px-4 rounded-md text-[12px] font-medium">
                      <Check size={14} />
                      Up to date
                    </div>
                  ) : appUpdater.status === 'ready' ? (
                    <button
                      onClick={appUpdater.restart}
                      className="flex items-center gap-2 bg-success hover:bg-success/90 text-white h-9 px-4 rounded-md text-[12px] font-medium transition-colors"
                    >
                      <Rocket size={14} />
                      Restart to Update
                    </button>
                  ) : appUpdater.status === 'downloading' ? (
                    <div className="flex items-center gap-2 bg-bg-secondary text-text-primary h-9 px-4 rounded-md text-[12px] font-medium">
                      <RefreshCw size={14} className="animate-spin" />
                      {appUpdater.downloadProgress}%
                    </div>
                  ) : appUpdater.status === 'available' ? (
                    <button
                      onClick={() => appUpdater.downloadAndInstall()}
                      className="flex items-center gap-2 bg-accent-primary hover:bg-accent-secondary text-white h-9 px-4 rounded-md text-[12px] font-medium transition-colors"
                    >
                      <Download size={14} />
                      Download Update
                    </button>
                  ) : (
                    <button
                      onClick={appUpdater.checkForUpdates}
                      disabled={appUpdater.status === 'checking'}
                      className="flex items-center gap-2 bg-bg-secondary ring-1 ring-border-light hover:bg-white/[0.04] text-text-primary h-9 px-4 rounded-md text-[12px] font-medium disabled:opacity-50 transition-colors"
                    >
                      {appUpdater.status === 'checking' ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      Check for Updates
                    </button>
                  )}
                </div>
              </div>

              {appUpdater.status === 'downloading' && (
                <div className="space-y-1">
                  <div className="h-1 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent-primary transition-all duration-300"
                      style={{ width: `${appUpdater.downloadProgress}%` }}
                    />
                  </div>
                  <p className="text-text-tertiary text-[11px]">Downloading update...</p>
                </div>
              )}

              {appUpdater.error && (
                <div className="text-[11px] p-2 rounded bg-error/10 text-error space-y-2">
                  <p>{appUpdater.error}</p>
                  <button
                    onClick={() => invoke('open_external_url', { url: 'https://github.com/talayash/claude-terminal/releases/latest' })}
                    className="flex items-center gap-1.5 text-accent-primary hover:text-accent-secondary transition-colors"
                  >
                    <ExternalLink size={12} />
                    Download manually from GitHub
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Claude Code Version */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Claude Code</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Current Version</p>
                  <p className="text-text-tertiary text-[11px]">
                    {isChecking ? 'Checking...' : claudeVersion || 'Not installed'}
                  </p>
                  {latestVersion && updateAvailable && (
                    <p className="text-accent-primary text-[11px] mt-1">
                      Update available: v{latestVersion}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={openDocs}
                    className="flex items-center gap-2 bg-bg-secondary ring-1 ring-border-light hover:bg-white/[0.04] text-text-primary h-9 px-3 rounded-md text-[12px] font-medium transition-colors"
                  >
                    <ExternalLink size={12} />
                    Docs
                  </button>
                  {updateAvailable === false ? (
                    <div className="flex items-center gap-2 bg-success/10 text-success h-9 px-4 rounded-md text-[12px] font-medium">
                      <Check size={14} />
                      Up to date
                    </div>
                  ) : (
                    <button
                      onClick={handleUpdateClaude}
                      disabled={isUpdating || isChecking}
                      className={`flex items-center gap-2 h-9 px-4 rounded-md text-[12px] font-medium disabled:opacity-50 transition-colors ${
                        updateAvailable
                          ? 'bg-accent-primary hover:bg-accent-secondary text-white'
                          : 'bg-bg-secondary ring-1 ring-border-light hover:bg-white/[0.04] text-text-primary'
                      }`}
                    >
                      {isUpdating ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : isChecking ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : updateStatus === 'success' ? (
                        <CheckCircle size={14} />
                      ) : updateStatus === 'error' ? (
                        <AlertCircle size={14} />
                      ) : (
                        <Download size={14} />
                      )}
                      {isUpdating ? 'Updating...' : isChecking ? 'Checking...' : 'Update'}
                    </button>
                  )}
                </div>
              </div>

              {updateMessage && (
                <div className={`text-[11px] p-2 rounded ${
                  updateStatus === 'success' ? 'bg-success/10 text-success' :
                  updateStatus === 'uptodate' ? 'bg-success/10 text-success' :
                  updateStatus === 'error' ? 'bg-error/10 text-error' :
                  'bg-bg-secondary text-text-secondary'
                }`}>
                  {updateMessage}
                </div>
              )}
            </div>
          </div>

          {/* Default Claude Arguments */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Default Claude Arguments</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-3">
              <p className="text-text-tertiary text-[11px]">
                Pre-filled when creating a new terminal. One argument per line.
              </p>
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                onBlur={() => setDefaultClaudeArgs(argsText.split('\n').filter(Boolean))}
                className="w-full bg-bg-elevated ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary font-mono h-24 resize-none transition-colors"
                placeholder="--dangerously-skip-permissions&#10;--model opus"
              />
              <p className="text-text-tertiary text-[11px]">
                Command: <code className="text-text-secondary">claude {argsText.split('\n').filter(Boolean).join(' ')}</code>
              </p>
            </div>
          </div>

          {/* Notifications */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Notifications</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Notify when terminal finishes</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Desktop notification when a terminal process exits
                  </p>
                </div>
                <button
                  onClick={() => {
                    setNotifyOnFinish(!notifyOnFinish);
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    notifyOnFinish ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      notifyOnFinish ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Project tools (file tree + scripts runner) */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Project Tools</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary text-[13px]">File tree &amp; package.json scripts</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Show the Explorer in the sidebar and enable the <span className="font-mono">package.json</span> scripts runner.
                  </p>
                </div>
                <button
                  onClick={() => setShowFileTree(!showFileTree)}
                  className={`relative w-10 h-5 rounded-full flex-shrink-0 mt-0.5 transition-colors ${
                    showFileTree ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      showFileTree ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* File Changes Panel */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">File Changes Panel</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Show Repositories section</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    List the root repo, worktree, and nested sub-repositories for the active terminal's folder
                  </p>
                </div>
                <button
                  onClick={() => setShowGitPanel(!showGitPanel)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    showGitPanel ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      showGitPanel ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Session */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Session</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Restore previous session</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Reopen terminals from last session on startup
                  </p>
                </div>
                <button
                  onClick={() => {
                    setRestoreSession(!restoreSession);
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    restoreSession ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      restoreSession ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Analytics */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Analytics</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Anonymous usage analytics</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Send anonymous app version and OS info to help improve ClaudeTerminal
                  </p>
                </div>
                <button
                  onClick={() => {
                    setTelemetryEnabled(!telemetryEnabled);
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    telemetryEnabled ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      telemetryEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Error Reporting */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Error Reporting</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Send error reports</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Helps fix crashes. No personal data — Windows usernames are scrubbed.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const next = !errorReportingEnabled;
                    setErrorReportingEnabled(next);
                    invoke('set_error_reporting_enabled', { enabled: next }).catch(() => {});
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    errorReportingEnabled ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      errorReportingEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Keyboard Shortcuts */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Keyboard Shortcuts</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-1.5">
              {[
                ['New Terminal', `${mod}+Shift+N`],
                ['Close Terminal', `${mod}+W`],
                ['Toggle Sidebar', `${mod}+B`],
                ['Command Palette', `${mod}+P`],
                ['Toggle Hints', 'F1'],
                ['Switch Tab', `${mod}+Tab`],
                ['Copy / Interrupt', `${mod}+C`],
                ['Paste', `${mod}+V`],
                ['Toggle Grid View', `${mod}+G`],
                ['Add to Grid', `${mod}+Shift+G`],
                ['Split View', `${mod}+\\`],
                ['Snippets', `${mod}+Shift+S`],
                ['Search Terminal', `${mod}+Shift+F`],
                ['Worktree Manager', `${mod}+Shift+W`],
                ['Claude Config', 'F6'],
              ].map(([label, shortcut]) => (
                <div key={label} className="flex justify-between text-[12px]">
                  <span className="text-text-secondary">{label}</span>
                  <kbd className="text-text-primary bg-bg-elevated px-2 py-0.5 rounded text-[11px] font-medium">{shortcut}</kbd>
                </div>
              ))}
            </div>
          </div>

          {/* About */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">About</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <p className="text-text-primary text-[13px]">ClaudeTerminal v{appVersion}</p>
              <p className="text-text-tertiary text-[11px] mt-0.5">
                A terminal manager for Claude Code
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
