import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Download, RefreshCw, CheckCircle, AlertCircle, ExternalLink, Check, Rocket, Minus, Plus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore, TERMINAL_SCROLLBACK_PRESETS, DEFAULT_TERMINAL_FONT_FAMILY } from '../store/appStore';
import { useUpdaterStore } from '../store/updaterStore';
import { toast } from '../store/toastStore';
import { TerminalAppearancePreview } from './TerminalAppearancePreview';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? 'Cmd' : 'Ctrl';

interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
}

// Curated font options shown in the Terminal Appearance section.
// `value` is the font-stack passed straight to xterm; `label` is what the
// user sees. "Auto" maps to the full DEFAULT stack so Windows users keep the
// silent Cascadia/Consolas fallback even if they never touch the picker.
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Auto (recommended)', value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: 'JetBrains Mono',     value: '"JetBrains Mono", monospace' },
  { label: 'Cascadia Code',      value: '"Cascadia Code", monospace' },
  { label: 'Cascadia Mono',      value: '"Cascadia Mono", monospace' },
  { label: 'Consolas',           value: 'Consolas, monospace' },
  { label: 'Fira Code',          value: '"Fira Code", monospace' },
  { label: 'SF Mono',            value: '"SF Mono", monospace' },
  { label: 'Source Code Pro',    value: '"Source Code Pro", monospace' },
  { label: 'Ubuntu Mono',        value: '"Ubuntu Mono", monospace' },
  { label: 'System monospace',   value: 'monospace' },
];

// Tailwind-friendly button styles for the segmented groups in the
// Terminal Appearance section. Kept here (rather than as components) since
// they're only used in one place — colocate with their consumer.
function segBtn(active: boolean): string {
  return `px-2.5 h-7 text-[12px] rounded-md transition-colors ${
    active
      ? 'bg-accent-primary text-white'
      : 'bg-bg-elevated ring-1 ring-border-light text-text-secondary hover:bg-white/[0.04]'
  }`;
}

export function SettingsModal() {
  const {
    closeSettings,
    defaultClaudeArgs, setDefaultClaudeArgs,
    notifyOnFinish, setNotifyOnFinish,
    restoreSession, setRestoreSession,
    telemetryEnabled, setTelemetryEnabled,
    errorReportingEnabled, setErrorReportingEnabled,
    showGitPanel, setShowGitPanel,
    showFileTree, setShowFileTree,
    terminalFontFamily, setTerminalFontFamily,
    terminalFontSize, setTerminalFontSize,
    terminalLineHeight, setTerminalLineHeight,
    terminalCursorStyle, setTerminalCursorStyle,
    terminalCursorBlink, setTerminalCursorBlink,
    terminalScrollback, setTerminalScrollback,
    terminalTheme, setTerminalTheme,
    terminalBidi, setTerminalBidi,
  } = useAppStore();
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

          {/* Terminal Appearance (issue #21) */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Terminal Appearance</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-3">
              <TerminalAppearancePreview />

              {/* Font family — native <select> with curated options. Each
                  option's value is a complete font-stack passed directly to
                  xterm. If a previously-persisted font isn't in the list
                  (e.g. from an older build), the select falls back to "Auto"
                  visually but the underlying value is preserved. */}
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="ct-font-family" className="text-text-primary text-[13px] flex-shrink-0">Font family</label>
                <select
                  id="ct-font-family"
                  value={FONT_OPTIONS.some(o => o.value === terminalFontFamily) ? terminalFontFamily : DEFAULT_TERMINAL_FONT_FAMILY}
                  onChange={(e) => setTerminalFontFamily(e.target.value)}
                  className="flex-1 min-w-0 bg-bg-elevated ring-1 ring-border-light rounded-md py-1 px-2 text-text-primary text-[12px] focus:outline-none focus:ring-accent-primary cursor-pointer"
                >
                  {FONT_OPTIONS.map((o) => (
                    <option key={o.label} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Font size — stepper */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-primary text-[13px]">Font size</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setTerminalFontSize(terminalFontSize - 1)} aria-label="Decrease font size" className="w-7 h-7 flex items-center justify-center bg-bg-elevated ring-1 ring-border-light rounded-md text-text-secondary hover:bg-white/[0.04]">
                    <Minus size={12} />
                  </button>
                  <span className="w-10 text-center text-text-primary text-[12px] tabular-nums">{terminalFontSize}</span>
                  <button onClick={() => setTerminalFontSize(terminalFontSize + 1)} aria-label="Increase font size" className="w-7 h-7 flex items-center justify-center bg-bg-elevated ring-1 ring-border-light rounded-md text-text-secondary hover:bg-white/[0.04]">
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              {/* Line height — stepper, 0.1 step */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-primary text-[13px]">Line height</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setTerminalLineHeight(terminalLineHeight - 0.1)} aria-label="Decrease line height" className="w-7 h-7 flex items-center justify-center bg-bg-elevated ring-1 ring-border-light rounded-md text-text-secondary hover:bg-white/[0.04]">
                    <Minus size={12} />
                  </button>
                  <span className="w-10 text-center text-text-primary text-[12px] tabular-nums">{terminalLineHeight.toFixed(1)}</span>
                  <button onClick={() => setTerminalLineHeight(terminalLineHeight + 0.1)} aria-label="Increase line height" className="w-7 h-7 flex items-center justify-center bg-bg-elevated ring-1 ring-border-light rounded-md text-text-secondary hover:bg-white/[0.04]">
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              {/* Cursor style — segmented */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-primary text-[13px]">Cursor style</span>
                <div className="flex gap-1">
                  {(['bar', 'block', 'underline'] as const).map((s) => (
                    <button key={s} onClick={() => setTerminalCursorStyle(s)} className={segBtn(terminalCursorStyle === s)}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cursor blink — toggle */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-primary text-[13px]">Cursor blink</span>
                <button
                  onClick={() => setTerminalCursorBlink(!terminalCursorBlink)}
                  aria-label="Toggle cursor blink"
                  className={`relative w-10 h-5 rounded-full transition-colors ${terminalCursorBlink ? 'bg-accent-primary' : 'bg-border-light'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${terminalCursorBlink ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Scrollback — preset segmented */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-text-primary text-[13px]">Scrollback</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">Lines retained per terminal. Lower values reduce memory in grid mode.</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {TERMINAL_SCROLLBACK_PRESETS.map((n) => (
                    <button key={n} onClick={() => setTerminalScrollback(n)} className={segBtn(terminalScrollback === n)}>
                      {n >= 1000 ? `${n / 1000}k` : `${n}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme — segmented */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-primary text-[13px]">Theme</span>
                <div className="flex gap-1">
                  {(['dark', 'light'] as const).map((t) => (
                    <button key={t} onClick={() => setTerminalTheme(t)} className={segBtn(terminalTheme === t)}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* BiDi — toggle, opt-in */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-text-primary text-[13px]">BiDi rendering</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">Right-to-left language support (Hebrew, Arabic, Persian). Toggling reattaches all open terminals.</p>
                </div>
                <button
                  onClick={() => setTerminalBidi(!terminalBidi)}
                  aria-label="Toggle BiDi rendering"
                  className={`relative w-10 h-5 rounded-full flex-shrink-0 mt-0.5 transition-colors ${terminalBidi ? 'bg-accent-primary' : 'bg-border-light'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${terminalBidi ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
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

          {/* Pastes */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Pastes</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-3">
              <p className="text-text-tertiary text-[11px]">
                Capture large pastes (logs, JSON) into a file under <code>.claudeterminal/pastes/</code> and reference them in Claude Code via @mention.
              </p>

              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Auto-detect large pastes</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Offer "Save as file" when you paste big chunks into a terminal.
                  </p>
                </div>
                <button
                  onClick={() => useAppStore.getState().setPasteAutoDetectEnabled(!useAppStore.getState().pasteAutoDetectEnabled)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    useAppStore((s) => s.pasteAutoDetectEnabled) ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      useAppStore((s) => s.pasteAutoDetectEnabled) ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="text-text-secondary text-[12px]">Threshold (bytes)</label>
                <input
                  type="number"
                  min={256}
                  value={useAppStore((s) => s.pasteAutoDetectThresholdBytes)}
                  onChange={(e) =>
                    useAppStore.getState().setPasteAutoDetectThresholdBytes(parseInt(e.target.value, 10) || 4096)
                  }
                  className="w-28 bg-bg-elevated text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="text-text-secondary text-[12px]">Threshold (lines)</label>
                <input
                  type="number"
                  min={5}
                  value={useAppStore((s) => s.pasteAutoDetectThresholdLines)}
                  onChange={(e) =>
                    useAppStore.getState().setPasteAutoDetectThresholdLines(parseInt(e.target.value, 10) || 50)
                  }
                  className="w-28 bg-bg-elevated text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-text-secondary text-[12px]">
                  Prompt template <span className="text-text-tertiary">(use <code>{'{path}'}</code>)</span>
                </label>
                <input
                  type="text"
                  value={useAppStore((s) => s.pastePromptTemplate)}
                  onChange={(e) => useAppStore.getState().setPastePromptTemplate(e.target.value)}
                  className="bg-bg-elevated text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border font-mono"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="text-text-secondary text-[12px]">Retention</label>
                <select
                  value={useAppStore((s) => s.pasteRetention)}
                  onChange={(e) =>
                    useAppStore.getState().setPasteRetention(e.target.value as 'close' | 'days' | 'forever')
                  }
                  className="bg-bg-elevated text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border"
                >
                  <option value="close">Delete on terminal close</option>
                  <option value="days">Keep for N days</option>
                  <option value="forever">Keep forever</option>
                </select>
              </div>

              {useAppStore((s) => s.pasteRetention) === 'days' && (
                <div className="flex items-center justify-between gap-3">
                  <label className="text-text-secondary text-[12px]">Days to keep</label>
                  <input
                    type="number"
                    min={1}
                    value={useAppStore((s) => s.pasteRetentionDays)}
                    onChange={(e) =>
                      useAppStore.getState().setPasteRetentionDays(parseInt(e.target.value, 10) || 7)
                    }
                    className="w-28 bg-bg-elevated text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Keyboard Shortcuts */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Keyboard Shortcuts</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3 space-y-1.5">
              {[
                ['New Terminal', `${mod}+Shift+N`],
                ['Close Terminal', `${mod}+W`],
                ['Toggle Explorer', `${mod}+B`],
                ['Command Palette', `${mod}+P`],
                ['Toggle Hints', 'F1'],
                ['Switch Tab', `${mod}+Tab`],
                ['Copy / Interrupt', `${mod}+C`],
                ['Paste', `${mod}+V`],
                ['Toggle Grid View', `${mod}+G`],
                ['Add to Grid', `${mod}+Shift+G`],
                ['Split View', `${mod}+\\`],
                ['Snippets', `${mod}+Shift+S`],
                ['Paste as File', `${mod}+Shift+V`],
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
