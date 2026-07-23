import { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { reportError } from './lib/errorReporter';
import { TitleBar } from './components/TitleBar';
import { Button } from './components/ui/Button';
import { ToolStripe } from './components/ToolStripe';
import { Sidebar } from './components/Sidebar';
import { TerminalTabs } from './components/TerminalTabs';
import { HintsPanel } from './components/HintsPanel';
import { FileChangesPanel } from './components/FileChangesPanel';
import { SettingsWindow } from './components/settings/SettingsWindow';
import { ProfileModal } from './components/ProfileModal';
import { NewTerminalModal } from './components/NewTerminalModal';
import { WorkspaceModal } from './components/WorkspaceModal';
import { WorktreeModal } from './components/WorktreeModal';
import { PushModal } from './components/PushModal';
import { SessionHistory } from './components/SessionHistory';
import { SnippetsModal } from './components/SnippetsModal';
import { PasteAsFileDrawer } from './components/PasteAsFileDrawer';
import { PromptEditorDrawer } from './components/PromptEditorDrawer';
import { CommandPalette } from './components/CommandPalette';
import { SetupWizard } from './components/SetupWizard';
import { AutoUpdater } from './components/AutoUpdater';
import { WhatsNewModal } from './components/WhatsNewModal';
import { ClaudeConfigModal } from './components/ClaudeConfigModal';
import { OrchestrationPanel } from './components/OrchestrationPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { PreviewInlineHint } from './components/PreviewInlineHint';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { SessionTimeline } from './components/SessionTimeline';
import { MemoryEditor } from './components/MemoryEditor';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/ToastContainer';
import { getWindowMode } from './lib/windowMode';
import { DragPreview } from './components/DragPreview';
import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { installTransferReceiver, requestTransfer, restoreDetachedWindow } from './lib/tabTransfer';
import { keyOf, upsertEntry, removeEntry, getDetachedEntries, currentGeometry } from './lib/windowLayout';
import { planRestoreModes } from './lib/restorePlan';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { TerminalConfig } from './store/terminalStore';
import { useAppStore } from './store/appStore';
import { useTerminalStore } from './store/terminalStore';
import { usePreviewStore } from './store/previewStore';
import { toast } from './store/toastStore';
import { detectUrl } from './lib/preview/detector';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotification } from './hooks/useNotification';
import { useSessionStateDetection } from './hooks/useSessionStateDetection';
import {
  applyAccentColor,
  applyThemeMode,
  applyDensity,
  applyReduceMotion,
  applyUiFontScale,
} from './lib/accentTheme';
import { listen } from '@tauri-apps/api/event';
import type { TerminalMetricsPayload } from './lib/sessionMetrics';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { initLsp } from './lib/lsp/lspClient';

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
  claude_session_id?: string | null;
}

function App() {
  const { sidebarOpen, sidebarCollapsed, hintsOpen, changesOpen, orchestrationOpen, settingsOpen, profileModalOpen, newTerminalModalOpen, workspaceModalOpen, worktreeModalOpen, pushModalOpen, sessionHistoryOpen, snippetsModalOpen, commandPaletteOpen, globalSearchOpen, whatsNewOpen, claudeConfigOpen, sessionTimelineOpen, memoryEditorOpen, showStatusBar, notifyOnFinish, restoreSession, triggerChangesRefresh, showRestoreBanner, pendingRestoreConfigs, setShowRestoreBanner, setPendingRestoreConfigs, lastSeenVersion, setLastSeenVersion, openWhatsNew } = useAppStore();
  const { handleTerminalOutput, updateTerminalStatus, setLoopMode, setSessionSummary, createTerminal, createShellTerminalTab, applyTerminalMetrics, adoptTerminal, detachTerminals, closeTerminal, terminals } = useTerminalStore();

  // Window identity. A torn-off ("detached") window renders the SAME full
  // layout as main (titlebar, sidebar with Sessions/Explorer, tabs, panels) but
  // skips the main-only lifecycle (setup wizard, session restore, auto-save,
  // telemetry) so it doesn't duplicate those side-effects.
  const { mode, label: windowLabel, initialIds } = getWindowMode();
  const isDetached = mode === 'detached';

  // Detached windows skip the setup gate and render the app directly.
  const [showSetup, setShowSetup] = useState<boolean | null>(isDetached ? false : null);
  const { notify } = useNotification();

  // Detached-window close ("ask each time") state.
  const [closePrompt, setClosePrompt] = useState(false);
  const closeConfirmedRef = useRef(false);
  const hasAdoptedRef = useRef(false);

  useKeyboardShortcuts();
  useSessionStateDetection();

  // v1.22.0 - apply theme/density/accent/motion/scale on store change.
  const themeMode = useAppStore((s) => s.themeMode);
  const uiDensity = useAppStore((s) => s.uiDensity);
  const accentColorHex = useAppStore((s) => s.accentColorHex);
  const uiReduceMotion = useAppStore((s) => s.uiReduceMotion);
  const uiFontScale = useAppStore((s) => s.uiFontScale);
  useEffect(() => {
    applyThemeMode(themeMode);
    applyDensity(uiDensity);
    applyAccentColor(accentColorHex);
    applyReduceMotion(uiReduceMotion);
    applyUiFontScale(uiFontScale);
  }, [themeMode, uiDensity, accentColorHex, uiReduceMotion, uiFontScale]);

  // Follow the OS "reduce motion" setting (WCAG 2.2 SC 2.3.3) on startup and
  // whenever it changes - but only until the user makes an explicit choice in
  // Settings, after which uiReduceMotionUserSet pins their preference. Routed
  // through setState (not setUiReduceMotion) so the auto-sync never marks the
  // value as user-set. The effect above then applies it to the DOM.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (useAppStore.getState().uiReduceMotionUserSet) return;
      useAppStore.setState({ uiReduceMotion: mq.matches });
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (isDetached) return; // no setup wizard in torn-off windows
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
  }, [isDetached]);

  // What's New check - runs after setup is confirmed
  useEffect(() => {
    if (isDetached) return;
    if (showSetup !== false) return;

    const checkWhatsNew = async () => {
      try {
        const currentVersion = await getVersion();
        if (!lastSeenVersion) {
          // Fresh install - just record the current version, no popup
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

  // Initialize the LSP client singleton once on mount. Subscribes to
  // openFiles / lspEnabled changes and wires diagnostics events to Monaco.
  useEffect(() => {
    initLsp();
  }, []);

  // Telemetry heartbeat - fire on startup then every 5 minutes
  useEffect(() => {
    if (isDetached) return;
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

  // Receive tabs torn off / transferred into THIS window, and release tabs that
  // get transferred away. Works for both main and detached (keyed on label).
  useEffect(
    () => installTransferReceiver(windowLabel, adoptTerminal, detachTerminals),
    [windowLabel, adoptTerminal, detachTerminals],
  );

  // Pre-create the transparent, always-on-top "drag-preview" overlay (hidden)
  // once, so tab drags can show the lifted tab OUTSIDE the window without
  // per-drag window-creation latency. Main window only.
  useEffect(() => {
    if (isDetached) return;
    let cancelled = false;
    (async () => {
      try {
        const existing = await getAllWebviewWindows();
        if (cancelled || existing.some((w) => w.label === 'drag-preview')) return;
        new WebviewWindow('drag-preview', {
          url: 'index.html?mode=dragpreview',
          width: 240,
          height: 64,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          focus: false,
          resizable: false,
          shadow: false,
          visible: false,
        });
      } catch (err) {
        console.error('Failed to create drag-preview overlay:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDetached]);

  // Detached windows adopt the specific tabs named in their URL: fetch configs
  // from the shared backend (no spawn) and seed scrollback from the session log.
  useEffect(() => {
    if (!isDetached) return;
    let cancelled = false;
    (async () => {
      try {
        if (initialIds.length > 0) {
          const all = await invoke<TerminalConfig[]>('get_terminals');
          const byId = new Map(all.map((c) => [c.id, c]));
          for (const id of initialIds) {
            const cfg = byId.get(id);
            if (!cfg) continue;
            let log: string | undefined;
            try {
              log = (await invoke<string | null>('get_session_log', { terminalId: id })) ?? undefined;
            } catch {
              /* no log — adopt without scrollback */
            }
            if (cancelled) return;
            adoptTerminal(cfg, log);
          }
        }
      } catch (err) {
        console.error('[detached] failed to adopt terminals:', err);
      } finally {
        if (!cancelled) hasAdoptedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDetached, initialIds, adoptTerminal]);

  // Detached close handling: intercept the OS close button to ask the user
  // ("return to main" / "close terminals"), and auto-close once the window is
  // emptied by dragging its last tab away.
  const closeUnlistenRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!isDetached) return;
    let active = true;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (closeConfirmedRef.current) return; // a choice was already made
        event.preventDefault();
        setClosePrompt(true);
      })
      .then((fn) => {
        if (active) closeUnlistenRef.current = fn;
        else fn(); // effect already cleaned up before the listener resolved
      });
    return () => {
      active = false;
      closeUnlistenRef.current?.();
      closeUnlistenRef.current = undefined;
    };
  }, [isDetached]);

  const ownedTabIds = () =>
    Array.from(useTerminalStore.getState().terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal)
      .map((t) => t.config.id);

  // Remove our own close interceptor first, THEN close — so this close isn't
  // intercepted again (the close()+flag dance was unreliable in WebView2).
  const forceCloseWindow = () => {
    closeConfirmedRef.current = true;
    closeUnlistenRef.current?.();
    closeUnlistenRef.current = undefined;
    setClosePrompt(false);
    // Deliberately closing this window (return/close/emptied) means it should
    // NOT be reopened next launch — drop it from the persisted layout.
    removeEntry(windowLabel);
    void getCurrentWindow().close();
  };

  // Auto-close a detached window once it has adopted its tabs and then becomes
  // empty (last tab dragged out / returned). No prompt in that case.
  const detachedTabCount = isDetached
    ? Array.from(terminals.values()).filter((t) => !t.scriptParentId && !t.isShellTerminal).length
    : 0;
  useEffect(() => {
    if (isDetached && hasAdoptedRef.current && detachedTabCount === 0) {
      forceCloseWindow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDetached, detachedTabCount]);

  // Persist this detached window's layout (which terminals + geometry) so it
  // can be reopened on next launch. Re-persists when its tab set changes and on
  // debounced move/resize.
  useEffect(() => {
    if (!isDetached) return;
    let unMoved: (() => void) | undefined;
    let unResized: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const persist = async () => {
      const sessionKeys = Array.from(useTerminalStore.getState().terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => keyOf(t.config));
      if (sessionKeys.length === 0) return; // empty window is removed on close
      const geometry = await currentGeometry();
      upsertEntry(windowLabel, { sessionKeys, geometry });
    };
    const persistDebounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void persist(), 400);
    };

    void persist();
    getCurrentWindow().onMoved(persistDebounced).then((fn) => { unMoved = fn; });
    getCurrentWindow().onResized(persistDebounced).then((fn) => { unResized = fn; });
    return () => {
      if (timer) clearTimeout(timer);
      unMoved?.();
      unResized?.();
    };
  }, [isDetached, windowLabel, detachedTabCount]);

  const handleReturnToMain = async () => {
    try {
      await requestTransfer('main', ownedTabIds(), windowLabel);
    } catch {
      // best effort — fall through to close
    }
    forceCloseWindow();
  };
  const handleCloseTerminals = async () => {
    for (const id of ownedTabIds()) {
      try {
        await closeTerminal(id);
      } catch {
        // already gone
      }
    }
    forceCloseWindow();
  };

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

      // Passive dev-server URL detection for the preview panel.
      // Script-runner children (`npm run dev`, etc.) emit output under their
      // own terminal id but the user is looking at the parent tab, so route
      // the URL to the parent when this terminal is a script child.
      try {
        const text = new TextDecoder().decode(new Uint8Array(data));
        const found = detectUrl(text);
        if (found) {
          const term = useTerminalStore.getState().terminals.get(id);
          const targetId = term?.scriptParentId ?? id;
          const cur = usePreviewStore.getState().perTerminal.get(targetId);
          if (cur?.detectedUrl !== found) {
            usePreviewStore.getState().setDetectedUrl(targetId, found);
          }
        }
      } catch { /* ignore decode errors */ }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [handleTerminalOutput, setLoopMode]);

  useEffect(() => {
    const unlisten = listen<TerminalMetricsPayload>('terminal-metrics', (event) => {
      applyTerminalMetrics(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyTerminalMetrics]);

  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);
  const budgetWarnedIds = useTerminalStore((s) => s.budgetWarnedIds);
  const markBudgetWarned = useTerminalStore((s) => s.markBudgetWarned);
  const sessionBudgetUsd = useAppStore((s) => s.sessionBudgetUsd);

  useEffect(() => {
    if (sessionBudgetUsd <= 0) return;
    for (const [id, m] of terminalMetrics) {
      if (m.costUsd >= sessionBudgetUsd && !budgetWarnedIds.has(id)) {
        markBudgetWarned(id);
        const inst = useTerminalStore.getState().terminals.get(id);
        const name = inst?.config.nickname || inst?.config.label || id;
        notify(
          'Session over budget',
          `"${name}" reached $${m.costUsd.toFixed(2)} (cap $${sessionBudgetUsd.toFixed(2)}).`,
        );
      }
    }
  }, [terminalMetrics, sessionBudgetUsd, budgetWarnedIds, markBudgetWarned, notify]);

  useEffect(() => {
    const unlisten = listen<{ id: string }>('terminal-finished', (event) => {
      const { id } = event.payload;

      // Get the current terminal name from the store (always up-to-date, even after renames)
      const terminals = useTerminalStore.getState().terminals;
      const terminal = terminals.get(id);
      const name = terminal?.config.nickname || terminal?.config.label || 'Terminal';

      updateTerminalStatus(id, 'Stopped');
      triggerChangesRefresh();

      // Notifications + summarization are owned by the main window so torn-off
      // windows don't double-fire them.
      if (isDetached) return;

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
  }, [notifyOnFinish, notify, updateTerminalStatus, setSessionSummary, isDetached]);

  // Restore previous session on startup - show banner instead of silently restoring
  useEffect(() => {
    if (isDetached) return; // detached windows adopt specific tabs, never restore all
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
    if (isDetached) return; // main owns session persistence
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

    // Map each restored terminal's stable key → its new (fresh) tab id, so we
    // can route terminals back into their detached windows below.
    const keyToNewId: Record<string, string> = {};

    // Decide session attachment up-front so no two terminals reattach to the
    // same Claude conversation (same-cwd terminals often carry the same
    // captured session id, and `--continue` always picks the single newest
    // session in a cwd). A duplicate would make everything typed/pasted in
    // one terminal show up in the others after restore.
    const restoreModes = planRestoreModes(pendingRestoreConfigs);

    for (let i = 0; i < pendingRestoreConfigs.length; i++) {
      const config = pendingRestoreConfigs[i];
      const stableKey = keyOf({
        claude_session_id: config.claude_session_id ?? null,
        working_directory: config.working_directory,
      });
      try {
        if (config.claude_args[0] === '__shell__') {
          // Plain shell - re-spawn as a main-tab shell. We deliberately don't
          // restore the script-runner sentinel '__script__' here; that's a
          // child terminal owned by its parent and gets recreated on demand.
          const newId = await createShellTerminalTab(
            config.label,
            config.working_directory,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
          );
          keyToNewId[stableKey] = newId;
        } else if (config.claude_args[0] === '__script__') {
          // Script runner - owned by parent terminal, skip on restore.
          continue;
        } else {
          // Restore semantics (deduped by planRestoreModes):
          //   - resume:   `claude --resume <id>` - exact attach. Claude
          //     redraws the conversation; we suppress the painted log so the
          //     transcript isn't doubled.
          //   - continue: `claude --continue` - newest session in this cwd
          //     (at most ONE terminal per cwd). Same suppression rule.
          //   - fresh:    plain `claude` + painted log. Used for duplicate
          //     session claims - visual context stays, but the terminal gets
          //     its own new conversation instead of hijacking another tab's.
          const mode = restoreModes[i];
          const newId = await createTerminal(
            config.label,
            config.working_directory,
            config.claude_args,
            config.env_vars,
            config.color_tag ?? undefined,
            config.nickname ?? undefined,
            mode.kind === 'fresh' ? (logs[i] ?? undefined) : undefined,
            mode.kind === 'resume' ? mode.sessionId : undefined,
            mode.kind === 'continue',
          );
          keyToNewId[stableKey] = newId;
        }
      } catch (err) {
        console.error('Failed to restore terminal:', config.label, err);
      }
    }

    // Reopen detached windows from the saved layout, moving their terminals out
    // of the main window into freshly-created windows at their saved geometry.
    try {
      const entries = getDetachedEntries();
      for (const { label, entry } of entries) {
        const ids = entry.sessionKeys
          .map((k) => keyToNewId[k])
          .filter((x): x is string => !!x);
        if (ids.length > 0) {
          await restoreDetachedWindow(ids, entry.geometry);
        }
        removeEntry(label); // stale label; the reopened window re-persists fresh
      }
    } catch (err) {
      console.error('Failed to restore detached windows:', err);
    }

    toast.success('Session Restored', `${pendingRestoreConfigs.length} terminal${pendingRestoreConfigs.length !== 1 ? 's' : ''} restored.`);
    setShowRestoreBanner(false);
    setPendingRestoreConfigs(null);
  };

  const handleDismissRestore = async () => {
    await invoke('clear_last_session');
    // Drop saved detached-window layout too — nothing was restored to populate them.
    for (const { label } of getDetachedEntries()) removeEntry(label);
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
          {!isDetached && <AutoUpdater />}

          {/* Restore Banner (F3) — main window only */}
          <AnimatePresence>
            {!isDetached && showRestoreBanner && pendingRestoreConfigs && (
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
                    <Button variant="primary" size="sm" onClick={handleRestore}>
                      Restore
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleDismissRestore}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <TitleBar />

          <div className="flex-1 flex overflow-hidden">
            <ToolStripe side="left" />

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

            <PreviewPanel />

            <ToolStripe side="right" />
          </div>

          {showStatusBar && <StatusBar />}

          <AnimatePresence>
            {settingsOpen && <SettingsWindow />}
            {profileModalOpen && <ProfileModal />}
            {newTerminalModalOpen && <NewTerminalModal />}
            {workspaceModalOpen && <WorkspaceModal />}
            {worktreeModalOpen && <WorktreeModal />}
            {pushModalOpen && <PushModal />}
            {sessionHistoryOpen && <SessionHistory />}
            {snippetsModalOpen && <SnippetsModal />}
            {!isDetached && whatsNewOpen && <WhatsNewModal />}
            {claudeConfigOpen && <ClaudeConfigModal />}
            {sessionTimelineOpen && <SessionTimeline />}
            {memoryEditorOpen && <MemoryEditor />}
          </AnimatePresence>
          {commandPaletteOpen && <CommandPalette />}
          <AnimatePresence>
            {globalSearchOpen && <GlobalSearchModal />}
          </AnimatePresence>
          <PasteAsFileDrawer />
          <PromptEditorDrawer />
        </>
      )}

      {/* Detached-window "ask each time" close dialog */}
      {isDetached && closePrompt && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50">
          <div className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-md p-4 w-[380px]">
            <h3 className="text-text-primary text-[13px] font-semibold mb-1">Close this window?</h3>
            <p className="text-text-tertiary text-[12px] mb-4">
              {detachedTabCount} terminal{detachedTabCount === 1 ? '' : 's'}{' '}
              {detachedTabCount === 1 ? 'is' : 'are'} open here. Return{' '}
              {detachedTabCount === 1 ? 'it' : 'them'} to the main window, or close{' '}
              {detachedTabCount === 1 ? 'it' : 'them'} entirely?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setClosePrompt(false)}
                className="px-3 h-8 text-text-secondary hover:text-text-primary hover:bg-white/[0.04] rounded-md text-[12px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { void handleCloseTerminals(); }}
                className="px-3 h-8 bg-red-500 hover:bg-red-600 text-white rounded-md text-[12px] font-medium transition-colors"
              >
                Close terminals
              </button>
              <button
                onClick={() => { void handleReturnToMain(); }}
                className="px-3 h-8 bg-accent-primary hover:bg-accent-secondary text-white rounded-md text-[12px] font-medium transition-colors"
              >
                Return to main
              </button>
            </div>
          </div>
        </div>
      )}

      <PreviewInlineHint />
      <ToastContainer />
    </div>
  );
}

function AppWithBoundary() {
  // The drag-preview overlay boots the same bundle but renders only the
  // floating tab — keep it out of the full app entirely.
  const { mode } = getWindowMode();
  return (
    <ErrorBoundary>
      {mode === 'dragpreview' ? <DragPreview /> : <App />}
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
