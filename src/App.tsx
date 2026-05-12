import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { reportError } from './lib/errorReporter';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { TerminalTabs } from './components/TerminalTabs';
import { HintsPanel } from './components/HintsPanel';
import { FileChangesPanel } from './components/FileChangesPanel';
import { SettingsModal } from './components/SettingsModal';
import { ProfileModal } from './components/ProfileModal';
import { NewTerminalModal } from './components/NewTerminalModal';
import { WorkspaceModal } from './components/WorkspaceModal';
import { WorktreeModal } from './components/WorktreeModal';
import { SessionHistory } from './components/SessionHistory';
import { SnippetsModal } from './components/SnippetsModal';
import { PasteAsFileDrawer } from './components/PasteAsFileDrawer';
import { CommandPalette } from './components/CommandPalette';
import { SetupWizard } from './components/SetupWizard';
import { AutoUpdater } from './components/AutoUpdater';
import { WhatsNewModal } from './components/WhatsNewModal';
import { ClaudeConfigModal } from './components/ClaudeConfigModal';
import { OrchestrationPanel } from './components/OrchestrationPanel';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { SessionTimeline } from './components/SessionTimeline';
import { MemoryEditor } from './components/MemoryEditor';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/ToastContainer';
import { useAppStore } from './store/appStore';
import { useTerminalStore } from './store/terminalStore';
import { toast } from './store/toastStore';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotification } from './hooks/useNotification';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(
      error.name,
      error.message,
      `${error.stack ?? ''}\n\nReact stack:${info.componentStack ?? ''}`,
    );
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-bg-primary flex items-center justify-center">
          <div className="text-center max-w-md p-6">
            <h2 className="text-text-primary text-lg font-semibold mb-2">Something went wrong</h2>
            <p className="text-text-secondary text-sm mb-4">
              The app hit an unexpected error. Reload to recover.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-accent-primary hover:bg-accent-secondary text-white px-4 py-2 rounded-md text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface SystemStatus {
  node_installed: boolean;
  node_version: string | null;
  npm_installed: boolean;
  npm_version: string | null;
  claude_installed: boolean;
  claude_version: string | null;
}

interface SavedTerminalConfig {
  id: string;
  label: string;
  nickname: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  color_tag: string | null;
}

function App() {
  const { sidebarOpen, sidebarCollapsed, hintsOpen, changesOpen, orchestrationOpen, settingsOpen, profileModalOpen, newTerminalModalOpen, workspaceModalOpen, worktreeModalOpen, sessionHistoryOpen, snippetsModalOpen, commandPaletteOpen, globalSearchOpen, whatsNewOpen, claudeConfigOpen, sessionTimelineOpen, memoryEditorOpen, notifyOnFinish, restoreSession, triggerChangesRefresh, showRestoreBanner, pendingRestoreConfigs, setShowRestoreBanner, setPendingRestoreConfigs, lastSeenVersion, setLastSeenVersion, openWhatsNew } = useAppStore();
  const { handleTerminalOutput, updateTerminalStatus, setLoopMode, setSessionSummary, createTerminal, createShellTerminalTab } = useTerminalStore();
  const [showSetup, setShowSetup] = useState<boolean | null>(null);
  const { notify } = useNotification();

  useKeyboardShortcuts();

  useEffect(() => {
    // Check if Claude Code is installed on startup
    const checkSetup = async () => {
      try {
        const status = await invoke<SystemStatus>('check_system_requirements');
        setShowSetup(!status.claude_installed);
      } catch {
        setShowSetup(true);
      }
    };
    checkSetup();
  }, []);

  // What's New check — runs after setup is confirmed
  useEffect(() => {
    if (showSetup !== false) return;

    const checkWhatsNew = async () => {
      try {
        const currentVersion = await getVersion();
        if (!lastSeenVersion) {
          // Fresh install — just record the current version, no popup
          setLastSeenVersion(currentVersion);
        } else if (lastSeenVersion !== currentVersion) {
          openWhatsNew();
        }
      } catch (err) {
        console.error('Failed to check version for What\'s New:', err);
      }
    };

    checkWhatsNew();
  }, [showSetup, lastSeenVersion, setLastSeenVersion, openWhatsNew]);

  // Push the persisted error-reporting preference to Rust on mount.
  // The Rust flag defaults to false, so until this fires no panics are reported.
  useEffect(() => {
    const enabled = useAppStore.getState().errorReportingEnabled;
    invoke('set_error_reporting_enabled', { enabled }).catch(() => {});
  }, []);

  // Telemetry heartbeat — fire on startup then every 5 minutes
  useEffect(() => {
    if (showSetup !== false) return;

    const sendHeartbeat = () => {
      const enabled = useAppStore.getState().telemetryEnabled;
      getVersion().then((appVersion) => {
        invoke('send_telemetry_heartbeat', { enabled, appVersion }).catch(() => {});
      });
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [showSetup]);

  useEffect(() => {
    const unlisten = listen<{ id: string; data: number[] }>('terminal-output', (event) => {
      const { id, data } = event.payload;
      handleTerminalOutput(id, new Uint8Array(data));

      // Detect loop mode from terminal output
      try {
        const text = new TextDecoder().decode(new Uint8Array(data));
        const loopMatch = text.match(/loop\s+(\d+[smh])\s+(.+)/i);
        if (loopMatch) {
          setLoopMode(id, { interval: loopMatch[1], prompt: loopMatch[2] });
        }
      } catch {
        // Ignore decode errors
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [handleTerminalOutput, setLoopMode]);

  useEffect(() => {
    const unlisten = listen<{ id: string }>('terminal-finished', (event) => {
      const { id } = event.payload;

      // Get the current terminal name from the store (always up-to-date, even after renames)
      const terminals = useTerminalStore.getState().terminals;
      const terminal = terminals.get(id);
      const name = terminal?.config.nickname || terminal?.config.label || 'Terminal';

      updateTerminalStatus(id, 'Stopped');
      triggerChangesRefresh();

      // Always show in-app toast
      toast.info('Terminal Finished', `${name} has finished running.`);

      if (notifyOnFinish) {
        notify('Terminal Finished', `${name} has finished running.`);
      }

      // Auto-summarize the session
      (async () => {
        try {
          // Check if we already have a summary
          const existing = await invoke<string | null>('get_session_summary', { terminalId: id });
          if (existing) {
            setSessionSummary(id, existing);
            return;
          }

          // Get the log path for this terminal
          const sessions = await invoke<{ id: number; terminal_id: string; log_path: string | null }[]>('get_session_history');
          const session = sessions.find(s => s.terminal_id === id);
          if (!session?.log_path) return;

          const summary = await invoke<string | null>('summarize_session', { logPath: session.log_path });
          if (summary) {
            await invoke('save_session_summary', { terminalId: id, summary });
            setSessionSummary(id, summary);
          }
        } catch (err) {
          console.error('Failed to summarize session:', err);
        }
      })();
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [notifyOnFinish, notify, updateTerminalStatus, setSessionSummary]);

  // Restore previous session on startup — show banner instead of silently restoring
  useEffect(() => {
    if (showSetup !== false) return;
    if (!restoreSession) return;

    const checkLastSession = async () => {
      try {
        const configs = await invoke<SavedTerminalConfig[] | null>('get_last_session');
        if (!configs || configs.length === 0) return;
        setPendingRestoreConfigs(configs);
        setShowRestoreBanner(true);
      } catch (err) {
        console.error('Failed to check last session:', err);
      }
    };

    checkLastSession();
  }, [showSetup]);

  // Auto-save session every 30 seconds
  useEffect(() => {
    if (showSetup !== false) return;

    const interval = setInterval(() => {
      invoke('save_session_for_restore').catch((err) => {
        console.error('Failed to auto-save session:', err);
      });
    }, 30000);

    return () => clearInterval(interval);
  }, [showSetup]);

  const handleRestore = async () => {
    if (!pendingRestoreConfigs) return;
    await invoke('clear_last_session');

    // Pre-fetch log content for all terminals in parallel
    const logPromises = pendingRestoreConfigs.map(async (config) => {
      if (!config.id) return null;
      try {
        return await invoke<string | null>('get_session_log', { terminalId: config.id });
      } catch {
        return null;
      }
    });
    const logs = await Promise.all(logPromises);

    for (let i = 0; i < pendingRestoreConfigs.length; i++) {
      const config = pendingRestoreConfigs[i];
      try {
        if (config.claude_args[0] === '__shell__') {
          // Plain shell — re-spawn as a main-tab shell. We deliberately don't
          // restore the script-runner sentinel '__script__' here; that's a
          // child terminal owned by its parent and gets recreated on demand.
          await createShellTerminalTab(
            config.label,
            config.working_directory,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
          );
        } else if (config.claude_args[0] === '__script__') {
          // Script runner — owned by parent terminal, skip on restore.
          continue;
        } else {
          await createTerminal(
            config.label,
            config.working_directory,
            config.claude_args,
            config.env_vars,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
            logs[i] ?? undefined
          );
        }
      } catch (err) {
        console.error('Failed to restore terminal:', config.label, err);
      }
    }
    toast.success('Session Restored', `${pendingRestoreConfigs.length} terminal${pendingRestoreConfigs.length !== 1 ? 's' : ''} restored.`);
    setShowRestoreBanner(false);
    setPendingRestoreConfigs(null);
  };

  const handleDismissRestore = async () => {
    await invoke('clear_last_session');
    setShowRestoreBanner(false);
    setPendingRestoreConfigs(null);
  };

  // Show loading while checking
  if (showSetup === null) {
    return (
      <div className="h-screen w-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-bg-primary flex flex-col overflow-hidden rounded-[4px] ring-1 ring-black/60">
      <AnimatePresence>
        {showSetup && (
          <SetupWizard onComplete={() => setShowSetup(false)} />
        )}
      </AnimatePresence>

      {!showSetup && (
        <>
          <AutoUpdater />

          {/* Restore Banner (F3) */}
          <AnimatePresence>
            {showRestoreBanner && pendingRestoreConfigs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-accent-primary/10 border-b border-accent-primary/20 overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-2.5">
                  <p className="text-text-primary text-[13px]">
                    Restore {pendingRestoreConfigs.length} terminal{pendingRestoreConfigs.length !== 1 ? 's' : ''} from your previous session?
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRestore}
                      className="bg-accent-primary hover:bg-accent-secondary text-white px-3 py-1 rounded-md text-[12px] font-medium transition-colors"
                    >
                      Restore
                    </button>
                    <button
                      onClick={handleDismissRestore}
                      className="text-text-secondary hover:text-text-primary px-3 py-1 rounded-md text-[12px] transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <TitleBar />

          <div className="flex-1 flex overflow-hidden">
            <AnimatePresence mode="wait">
              {sidebarOpen && (
                <div
                  className="h-full overflow-hidden transition-all duration-200 ease-out"
                  style={{ width: sidebarCollapsed ? 48 : 280 }}
                >
                  <Sidebar />
                </div>
              )}
            </AnimatePresence>

            <main className="flex-1 flex flex-col overflow-hidden">
              <TerminalTabs />
            </main>

            <AnimatePresence mode="wait">
              {changesOpen && (
                <div
                  className="h-full overflow-hidden transition-all duration-150 ease-out"
                  style={{ width: 420 }}
                >
                  <FileChangesPanel />
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {orchestrationOpen && (
                <div
                  className="h-full overflow-hidden transition-all duration-150 ease-out"
                  style={{ width: 320 }}
                >
                  <OrchestrationPanel />
                </div>
              )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {hintsOpen && (
                <div
                  className="h-full overflow-hidden transition-all duration-150 ease-out"
                  style={{ width: 320 }}
                >
                  <HintsPanel />
                </div>
              )}
            </AnimatePresence>
          </div>

          <StatusBar />

          <AnimatePresence>
            {settingsOpen && <SettingsModal />}
            {profileModalOpen && <ProfileModal />}
            {newTerminalModalOpen && <NewTerminalModal />}
            {workspaceModalOpen && <WorkspaceModal />}
            {worktreeModalOpen && <WorktreeModal />}
            {sessionHistoryOpen && <SessionHistory />}
            {snippetsModalOpen && <SnippetsModal />}
            {whatsNewOpen && <WhatsNewModal />}
            {claudeConfigOpen && <ClaudeConfigModal />}
            {sessionTimelineOpen && <SessionTimeline />}
            {memoryEditorOpen && <MemoryEditor />}
          </AnimatePresence>
          {commandPaletteOpen && <CommandPalette />}
          <AnimatePresence>
            {globalSearchOpen && <GlobalSearchModal />}
          </AnimatePresence>
          <PasteAsFileDrawer />
        </>
      )}

      <ToastContainer />
    </div>
  );
}

function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
