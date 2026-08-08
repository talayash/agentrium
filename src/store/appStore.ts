import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalThemeName } from '../lib/terminalThemes';
import { MAX_GRID_TERMINALS } from '../lib/gridEmptyCells';
import { addPin, removePin, togglePin } from '../lib/pinnedTabs';

export type TerminalCursorStyle = 'bar' | 'block' | 'underline';
export type TerminalScrollbarMode = 'auto-hide' | 'always' | 'hidden';
export const TERMINAL_SCROLLBACK_PRESETS = [1000, 10000, 50000, 100000] as const;
// Stack JetBrains Mono first (kept for users who have it) → Cascadia Code
// (ships with modern Windows / VS Code) → Consolas (always installed on
// Windows). Without this, Windows users silently fell back to Courier New.
export const DEFAULT_TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, "Fira Code", monospace';
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

// IntelliJ overhaul (v1.22.0) - appearance + behavior settings.
export type UiDensity = 'compact' | 'comfortable' | 'spacious';
export type TabHeight = 'small' | 'medium' | 'large';
export type ThemeMode = 'dark' | 'light' | 'auto';
export type AutoStageMode = 'none' | 'tracked' | 'all';
export type MergeStrategy = 'merge' | 'rebase' | 'ff-only';
export const DEFAULT_ACCENT_COLOR = '#3574F0';
export const DEFAULT_UI_FONT_SCALE = 1.0;
export const DEFAULT_EDITOR_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", Consolas, monospace';

export type GridLayout = '1x1' | '1x2' | '2x1' | '2x2' | '1x3' | '3x1' | '2x3' | '3x2' | '2x4' | '4x2';

export type SplitOrientation = 'horizontal' | 'vertical';

export interface FileTabState {
  path: string;
  content: string;
  original: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  // 'edit' → plain Monaco editor. 'diff' → Monaco DiffEditor showing HEAD vs working copy.
  mode: 'edit' | 'diff';
  // HEAD version, used as the "original" side in diff mode. Empty string for
  // new/untracked files. Always present so the user can toggle into diff mode.
  headContent: string;
  // Repo context for re-fetching HEAD (mode switches, reloads).
  repoRoot: string | null;
  relativePath: string | null;
}

interface AppState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;  // widths driven by --w-rail / --w-panel tokens
  hintsOpen: boolean;
  changesOpen: boolean;
  settingsOpen: boolean;
  profileModalOpen: boolean;
  editingProfileId: string | null;
  newTerminalModalOpen: boolean;
  workspaceModalOpen: boolean;
  worktreeModalOpen: boolean;
  worktreeModalRepoPath: string | null;
  pushModalOpen: boolean;
  pushModalRepoPath: string | null;
  defaultClaudeArgs: string[];
  notifyOnFinish: boolean;
  /** Count of terminal-finished events fired while the app was hidden and not
   *  yet acknowledged by the user. Renders the accent dot on the status-bar bell. */
  unreadNotificationCount: number;
  incrementUnreadNotifications: () => void;
  clearUnreadNotifications: () => void;
  /** Label of the currently-busy global activity (LSP starting, git fetch/pull),
   *  or null. Drives the 2px ProgressStripe above the status bar. Ephemeral -
   *  never persisted. */
  globalBusy: string | null;
  setGlobalBusy: (label: string | null) => void;
  restoreSession: boolean;
  telemetryEnabled: boolean;
  errorReportingEnabled: boolean;
  // Master switch for language-server features (diagnostics squiggles).
  lspEnabled: boolean;
  setLspEnabled: (v: boolean) => void;
  // Per-session OTel cost/token tracking (distinct from the analytics heartbeat
  // `telemetryEnabled`, which reports to ct-analytics). This is local only.
  costTrackingEnabled: boolean;
  // Per-session budget ceiling in USD; 0 = no cap. Used by Task 11.
  sessionBudgetUsd: number;
  setCostTrackingEnabled: (v: boolean) => void;
  setSessionBudgetUsd: (v: number) => void;
  showGitPanel: boolean;
  showFileTree: boolean;

  // Terminal appearance (issue #21)
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalTheme: TerminalThemeName;
  terminalBidi: boolean;
  terminalScrollbarMode: TerminalScrollbarMode;

  // Appearance & Behavior (NEW v1.22.0)
  themeMode: ThemeMode;
  uiDensity: UiDensity;
  /** Editor/terminal tab strip height. IntelliJ New UI offers Small/Medium/
   *  Large; we mirror those (24/28/32px). Consumed via --h-tab CSS var
   *  written by accentTheme.applyTabHeight(). */
  tabHeight: TabHeight;
  accentColorHex: string;
  uiFontScale: number;
  uiReduceMotion: boolean;
  // True once the user has explicitly toggled "Reduce motion" in Settings. Until
  // then we follow the OS prefers-reduced-motion setting (WCAG 2.2 SC 2.3.3).
  uiReduceMotionUserSet: boolean;
  // Minimal-UI / chrome toggles (P1-3) - let users strip non-essential chrome.
  showStatusBar: boolean;
  showTabActivity: boolean;
  compactTitleBar: boolean;
  notificationSoundEnabled: boolean;
  dndEnabled: boolean;
  dndStart: string;
  dndEnd: string;
  sessionAutoSaveIntervalSec: number;
  confirmOnAppClose: boolean;

  // Editor (NEW v1.22.0) - Monaco
  editorTabSize: number;
  editorRenderWhitespace: boolean;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  editorAutoSaveOnBlur: boolean;
  editorFontFamily: string;
  editorFontSize: number;
  editorLineHeight: number;

  // Terminal behavior (NEW v1.22.0)
  terminalShellPathOverride: string;
  terminalCopyOnSelect: boolean;
  terminalPasteShortcut: 'ctrl+v' | 'ctrl+shift+v';

  // VCS (NEW v1.22.0)
  vcsCommitMessageTemplate: string;
  vcsDefaultAutoStage: AutoStageMode;
  vcsDefaultMergeStrategy: MergeStrategy;
  vcsChangelistsConfirmDelete: boolean;

  // Claude Code defaults (NEW v1.22.0)
  claudeDefaultModel: 'opus' | 'sonnet' | 'haiku' | null;
  claudeBinaryPathOverride: string;

  // Changes panel
  changesRefreshTrigger: number;

  // Shared repo selection - file changes panel pins a repo, file tree follows it
  pinnedRepoPath: string | null;

  // File tabs (Monaco editor tabs living next to terminal tabs)
  openFiles: FileTabState[];
  activeFilePath: string | null;

  // Sidebar layout
  explorerHeightRatio: number; // 0.15..0.85, portion of sidebar height reserved for Explorer
  toolsCollapsed: boolean; // sidebar footer (Workspaces/Snippets/etc.) - collapsed gives Explorer more height
  // Persistent collapse state for the two stacked sidebar sections.
  sessionsCollapsed: boolean;
  explorerCollapsed: boolean;
  // Portion of the (Sessions + Explorer) column reserved for Sessions when
  // both sections are expanded. 0.15..0.85; the rest goes to Explorer.
  sessionsHeightRatio: number;

  // File Changes panel split: Repositories (top) vs Changes (bottom)
  repositoriesHeightRatio: number; // 0.15..0.85

  // Global Search (Ctrl+Shift+F)
  globalSearchOpen: boolean;

  // Grid state
  gridMode: boolean;
  gridTerminalIds: string[];
  gridLayout: GridLayout;
  gridFocusedIndex: number | null;

  // Pinned tabs — persist by id so relaunched sessions stay pinned across app restarts.
  // Terminals themselves are ephemeral; pins are just intent-preserving metadata.
  // Bulk close actions (Close Others, Close All But Pinned) live in the tab
  // context-menu logic, not the store — see Task D.
  pinnedTabIds: string[];
  pinTab: (id: string) => void;
  unpinTab: (id: string) => void;
  toggleTabPin: (id: string) => void;

  // Command Palette (F1)
  commandPaletteOpen: boolean;
  // Frecency: per-action usage so the palette can surface a "Recent" group and
  // rank matches by frequency + recency. Keyed by a stable string (e.g.
  // "cmd:New Terminal", "snippet:<id>", "hint:<command>") - never terminal ids,
  // which are ephemeral and would leak into persisted storage.
  paletteUsage: Record<string, { count: number; lastUsedTs: number }>;

  // Session History (F2)
  sessionHistoryOpen: boolean;

  // Crash Recovery (F3)
  showRestoreBanner: boolean;
  pendingRestoreConfigs: SavedTerminalConfig[] | null;

  // Split Pane (Ctrl+\)
  splitMode: boolean;
  splitTerminalIds: [string, string] | null;
  splitOrientation: SplitOrientation;
  splitRatio: number;

  // Agent Teams (F4)
  orchestrationOpen: boolean;

  // Snippets (F5)
  snippetsModalOpen: boolean;

  // Claude Config (F6)
  claudeConfigOpen: boolean;

  // Session Timeline (F7)
  sessionTimelineOpen: boolean;

  // Memory Editor (F8)
  memoryEditorOpen: boolean;

  // What's New
  whatsNewOpen: boolean;
  lastSeenVersion: string | null;

  // Paste-as-File drawer
  pasteDrawerOpen: boolean;
  pasteDrawerSeed: { content: string; targetTerminalId: string | null } | null;
  // Paste settings (persisted)
  pasteAutoDetectEnabled: boolean;
  pasteAutoDetectThresholdBytes: number;
  pasteAutoDetectThresholdLines: number;
  pastePromptTemplate: string;
  pasteRetention: 'close' | 'days' | 'forever';
  pasteRetentionDays: number;

  // Prompt Editor (compose a prompt in a popup, inject into the terminal input)
  promptEditorOpen: boolean;
  promptEditorTargetId: string | null;
  // Text captured from the terminal's current input line when the editor was
  // opened, so it can seed/continue an in-progress prompt. Ephemeral.
  promptEditorSeed: string | null;
  // Unsent prompt draft per terminal id. Ephemeral on purpose - terminals
  // don't survive an app restart, so a persisted draft would orphan.
  promptDrafts: Record<string, string>;
  // Whether the Ctrl+Shift+E shortcut opens the Prompt Editor (persisted).
  // The status-bar pencil is always available regardless of this.
  promptEditorShortcutEnabled: boolean;

  toggleSidebar: () => void;
  toggleSidebarCollapse: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleHints: () => void;
  toggleChanges: () => void;
  triggerChangesRefresh: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openProfileModal: (profileId?: string) => void;
  closeProfileModal: () => void;
  openNewTerminalModal: () => void;
  closeNewTerminalModal: () => void;
  openWorkspaceModal: () => void;
  closeWorkspaceModal: () => void;
  openWorktreeModal: (repoPath: string) => void;
  closeWorktreeModal: () => void;
  openPushModal: (repoPath: string) => void;
  closePushModal: () => void;
  setDefaultClaudeArgs: (args: string[]) => void;
  setNotifyOnFinish: (enabled: boolean) => void;
  setRestoreSession: (enabled: boolean) => void;
  setTelemetryEnabled: (enabled: boolean) => void;
  setErrorReportingEnabled: (enabled: boolean) => void;
  setShowGitPanel: (enabled: boolean) => void;
  setShowFileTree: (enabled: boolean) => void;

  // Terminal appearance setters (issue #21)
  setTerminalFontFamily: (font: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalCursorStyle: (style: TerminalCursorStyle) => void;
  setTerminalCursorBlink: (enabled: boolean) => void;
  setTerminalScrollback: (lines: number) => void;
  setTerminalTheme: (theme: TerminalThemeName) => void;
  setTerminalBidi: (enabled: boolean) => void;
  setTerminalScrollbarMode: (mode: TerminalScrollbarMode) => void;

  // Appearance & Behavior setters (NEW v1.22.0)
  setThemeMode: (mode: ThemeMode) => void;
  setUiDensity: (density: UiDensity) => void;
  setTabHeight: (h: TabHeight) => void;
  setAccentColorHex: (hex: string) => void;
  setUiFontScale: (scale: number) => void;
  setUiReduceMotion: (enabled: boolean) => void;
  recordPaletteUse: (key: string) => void;
  setShowStatusBar: (v: boolean) => void;
  setShowTabActivity: (v: boolean) => void;
  setCompactTitleBar: (v: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setDndEnabled: (enabled: boolean) => void;
  setDndStart: (hhmm: string) => void;
  setDndEnd: (hhmm: string) => void;
  setSessionAutoSaveIntervalSec: (sec: number) => void;
  setConfirmOnAppClose: (enabled: boolean) => void;

  // Editor setters (NEW v1.22.0)
  setEditorTabSize: (size: number) => void;
  setEditorRenderWhitespace: (enabled: boolean) => void;
  setEditorWordWrap: (enabled: boolean) => void;
  setEditorMinimap: (enabled: boolean) => void;
  setEditorAutoSaveOnBlur: (enabled: boolean) => void;
  setEditorFontFamily: (family: string) => void;
  setEditorFontSize: (size: number) => void;
  setEditorLineHeight: (height: number) => void;

  // Terminal behavior setters (NEW v1.22.0)
  setTerminalShellPathOverride: (path: string) => void;
  setTerminalCopyOnSelect: (enabled: boolean) => void;
  setTerminalPasteShortcut: (shortcut: 'ctrl+v' | 'ctrl+shift+v') => void;

  // VCS setters (NEW v1.22.0)
  setVcsCommitMessageTemplate: (template: string) => void;
  setVcsDefaultAutoStage: (mode: AutoStageMode) => void;
  setVcsDefaultMergeStrategy: (strategy: MergeStrategy) => void;
  setVcsChangelistsConfirmDelete: (enabled: boolean) => void;

  // Claude setters (NEW v1.22.0)
  setClaudeDefaultModel: (model: 'opus' | 'sonnet' | 'haiku' | null) => void;
  setClaudeBinaryPathOverride: (path: string) => void;

  setPinnedRepoPath: (path: string | null) => void;
  openFileTab: (path: string) => Promise<void>;
  openDiffTab: (path: string, repoRoot: string, relativePath: string) => Promise<void>;
  closeFileTab: (path: string) => void;
  setActiveFilePath: (path: string | null) => void;
  setFileTabContent: (path: string, content: string) => void;
  setFileTabError: (path: string, error: string | null) => void;
  setFileTabMode: (path: string, mode: 'edit' | 'diff') => void;
  saveFileTab: (path: string) => Promise<void>;
  reloadFileTab: (path: string) => Promise<void>;
  setExplorerHeightRatio: (ratio: number) => void;
  setRepositoriesHeightRatio: (ratio: number) => void;
  toggleToolsCollapsed: () => void;
  toggleSessionsCollapsed: () => void;
  toggleExplorerCollapsed: () => void;
  setSessionsHeightRatio: (ratio: number) => void;

  // Global Search actions (Ctrl+Shift+F)
  openGlobalSearch: () => void;
  closeGlobalSearch: () => void;
  toggleGlobalSearch: () => void;

  // Grid actions
  toggleGridMode: () => void;
  setGridMode: (enabled: boolean) => void;
  addToGrid: (terminalId: string) => void;
  removeFromGrid: (terminalId: string) => void;
  setGridTerminals: (terminalIds: string[]) => void;
  setGridLayout: (layout: GridLayout) => void;
  setGridFocusedIndex: (index: number | null) => void;
  clearGrid: () => void;
  swapGridPositions: (fromIndex: number, toIndex: number) => void;
  replaceInGrid: (index: number, terminalId: string) => void;

  // Command Palette actions (F1)
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  // Session History actions (F2)
  openSessionHistory: () => void;
  closeSessionHistory: () => void;

  // Crash Recovery actions (F3)
  setShowRestoreBanner: (show: boolean) => void;
  setPendingRestoreConfigs: (configs: SavedTerminalConfig[] | null) => void;

  // Split Pane actions (Ctrl+\)
  toggleSplitMode: () => void;
  setSplitMode: (enabled: boolean) => void;
  setSplitTerminals: (ids: [string, string] | null) => void;
  setSplitOrientation: (orientation: SplitOrientation) => void;
  setSplitRatio: (ratio: number) => void;
  clearSplit: () => void;

  // Agent Teams actions (F4)
  toggleOrchestration: () => void;

  // Snippets actions (F5)
  openSnippetsModal: () => void;
  closeSnippetsModal: () => void;

  // Claude Config actions (F6)
  openClaudeConfig: () => void;
  closeClaudeConfig: () => void;

  // Session Timeline actions (F7)
  openSessionTimeline: () => void;
  closeSessionTimeline: () => void;
  toggleSessionTimeline: () => void;

  // Memory Editor actions (F8)
  openMemoryEditor: () => void;
  closeMemoryEditor: () => void;

  // What's New actions
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
  setLastSeenVersion: (version: string) => void;

  // Paste-as-File actions
  openPasteDrawer: (seed?: { content?: string; targetTerminalId?: string | null }) => void;
  closePasteDrawer: () => void;
  setPasteAutoDetectEnabled: (enabled: boolean) => void;
  setPasteAutoDetectThresholdBytes: (n: number) => void;
  setPasteAutoDetectThresholdLines: (n: number) => void;
  setPastePromptTemplate: (s: string) => void;
  setPasteRetention: (r: 'close' | 'days' | 'forever') => void;
  setPasteRetentionDays: (n: number) => void;

  // Prompt Editor actions
  openPromptEditor: (terminalId?: string | null, seedText?: string | null) => void;
  closePromptEditor: () => void;
  setPromptDraft: (terminalId: string, text: string) => void;
  clearPromptDraft: (terminalId: string) => void;
  setPromptEditorShortcutEnabled: (enabled: boolean) => void;
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

// Helper to determine optimal layout based on terminal count
export function getOptimalLayout(count: number): GridLayout {
  switch (count) {
    case 1: return '1x1';
    case 2: return '1x2';
    case 3: return '1x3';
    case 4: return '2x2';
    case 5:
    case 6: return '2x3';
    case 7:
    case 8: return '2x4';
    default: return '1x1';
  }
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarCollapsed: false,
      hintsOpen: false,
      changesOpen: false,
      settingsOpen: false,
      profileModalOpen: false,
      editingProfileId: null,
      newTerminalModalOpen: false,
      workspaceModalOpen: false,
      worktreeModalOpen: false,
      worktreeModalRepoPath: null,
      pushModalOpen: false,
      pushModalRepoPath: null,
      defaultClaudeArgs: [],
      notifyOnFinish: true,
      unreadNotificationCount: 0,
      incrementUnreadNotifications: () =>
        set((s) => ({ unreadNotificationCount: s.unreadNotificationCount + 1 })),
      clearUnreadNotifications: () => set({ unreadNotificationCount: 0 }),
      globalBusy: null,
      setGlobalBusy: (label) => set({ globalBusy: label }),
      restoreSession: true,
      telemetryEnabled: true,
      errorReportingEnabled: true,
      lspEnabled: true,
      costTrackingEnabled: false,
      sessionBudgetUsd: 0,
      showGitPanel: true,
      showFileTree: true,

      // Terminal appearance defaults (issue #21).
      // Scrollback default reduced from 100k → 50k to ease grid-mode memory.
      terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      terminalLineHeight: 1.2,
      terminalCursorStyle: 'bar' as TerminalCursorStyle,
      terminalCursorBlink: true,
      terminalScrollback: 50000,
      terminalTheme: 'dark' as TerminalThemeName,
      terminalBidi: false,
      terminalScrollbarMode: 'auto-hide' as TerminalScrollbarMode,

      // Appearance & Behavior defaults (NEW v1.22.0)
      themeMode: 'dark' as ThemeMode,
      uiDensity: 'comfortable' as UiDensity,
      tabHeight: 'medium' as TabHeight,
      accentColorHex: DEFAULT_ACCENT_COLOR,
      uiFontScale: DEFAULT_UI_FONT_SCALE,
      uiReduceMotion: false,
      uiReduceMotionUserSet: false,
      showStatusBar: true,
      showTabActivity: true,
      compactTitleBar: false,
      notificationSoundEnabled: false,
      dndEnabled: false,
      dndStart: '22:00',
      dndEnd: '08:00',
      sessionAutoSaveIntervalSec: 30,
      confirmOnAppClose: true,

      // Editor defaults (NEW v1.22.0)
      editorTabSize: 2,
      editorRenderWhitespace: false,
      editorWordWrap: true,
      editorMinimap: false,
      editorAutoSaveOnBlur: false,
      editorFontFamily: DEFAULT_EDITOR_FONT_FAMILY,
      editorFontSize: 13,
      editorLineHeight: 1.5,

      // Terminal behavior defaults (NEW v1.22.0)
      terminalShellPathOverride: '',
      terminalCopyOnSelect: false,
      terminalPasteShortcut: 'ctrl+v' as 'ctrl+v' | 'ctrl+shift+v',

      // VCS defaults (NEW v1.22.0)
      vcsCommitMessageTemplate: '',
      vcsDefaultAutoStage: 'none' as AutoStageMode,
      vcsDefaultMergeStrategy: 'merge' as MergeStrategy,
      vcsChangelistsConfirmDelete: true,

      // Claude defaults (NEW v1.22.0)
      claudeDefaultModel: null as 'opus' | 'sonnet' | 'haiku' | null,
      claudeBinaryPathOverride: '',

      // Changes panel
      changesRefreshTrigger: 0,

      // Shared repo selection
      pinnedRepoPath: null,

      // File tabs
      openFiles: [],
      activeFilePath: null,

      // Sidebar explorer ratio (default: explorer takes 45% of sidebar height)
      explorerHeightRatio: 0.45,
      // Tools footer collapsed by default - surfaces more explorer space; user
      // can expand on demand to reach Workspaces / Snippets / Profiles / etc.
      toolsCollapsed: true,
      // Sessions section starts collapsed so the Explorer (the more frequent
      // tool) keeps its current screen real estate by default. Users opt-in.
      sessionsCollapsed: true,
      explorerCollapsed: false,
      sessionsHeightRatio: 0.35,

      // File Changes split (default: repositories takes 35% of available column)
      repositoriesHeightRatio: 0.35,

      // Global Search (Ctrl+Shift+F)
      globalSearchOpen: false,

      // Grid state
      gridMode: false,
      gridTerminalIds: [],
      gridLayout: '1x1',
      gridFocusedIndex: null,

      // Pinned tabs — id list only; terminals themselves remain ephemeral in
      // terminalStore. See src/lib/pinnedTabs.ts for the pure helpers.
      pinnedTabIds: [],

      // Command Palette (F1)
      commandPaletteOpen: false,
      paletteUsage: {},

      // Session History (F2)
      sessionHistoryOpen: false,

      // Crash Recovery (F3)
      showRestoreBanner: false,
      pendingRestoreConfigs: null,

      // Split Pane (Ctrl+\)
      splitMode: false,
      splitTerminalIds: null,
      splitOrientation: 'horizontal' as SplitOrientation,
      splitRatio: 0.5,

      // Agent Teams (F4)
      orchestrationOpen: false,

      // Snippets (F5)
      snippetsModalOpen: false,

      // Claude Config (F6)
      claudeConfigOpen: false,

      // Session Timeline (F7)
      sessionTimelineOpen: false,

      // Memory Editor (F8)
      memoryEditorOpen: false,

      // What's New
      whatsNewOpen: false,
      lastSeenVersion: null,

      // Paste-as-File drawer
      pasteDrawerOpen: false,
      pasteDrawerSeed: null,
      pasteAutoDetectEnabled: true,
      pasteAutoDetectThresholdBytes: 4096,
      pasteAutoDetectThresholdLines: 50,
      pastePromptTemplate: 'Please look at @{path}',
      pasteRetention: 'close' as 'close' | 'days' | 'forever',
      pasteRetentionDays: 7,

      // Prompt Editor
      promptEditorOpen: false,
      promptEditorTargetId: null,
      promptEditorSeed: null,
      promptDrafts: {},
      promptEditorShortcutEnabled: true,

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      toggleSidebarCollapse: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleHints: () => set((state) => ({ hintsOpen: !state.hintsOpen })),
      toggleChanges: () => set((state) => ({ changesOpen: !state.changesOpen })),
      triggerChangesRefresh: () => set((state) => ({ changesRefreshTrigger: state.changesRefreshTrigger + 1 })),
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      openProfileModal: (profileId) => set({ profileModalOpen: true, editingProfileId: profileId || null }),
      closeProfileModal: () => set({ profileModalOpen: false, editingProfileId: null }),
      openNewTerminalModal: () => set({ newTerminalModalOpen: true }),
      closeNewTerminalModal: () => set({ newTerminalModalOpen: false }),
      openWorkspaceModal: () => set({ workspaceModalOpen: true }),
      closeWorkspaceModal: () => set({ workspaceModalOpen: false }),
      openWorktreeModal: (repoPath) => set({ worktreeModalOpen: true, worktreeModalRepoPath: repoPath }),
      closeWorktreeModal: () => set({ worktreeModalOpen: false, worktreeModalRepoPath: null }),
      openPushModal: (repoPath) => set({ pushModalOpen: true, pushModalRepoPath: repoPath }),
      closePushModal: () => set({ pushModalOpen: false, pushModalRepoPath: null }),
      setDefaultClaudeArgs: (args) => set({ defaultClaudeArgs: args }),
      setNotifyOnFinish: (enabled) => set({ notifyOnFinish: enabled }),
      setRestoreSession: (enabled) => set({ restoreSession: enabled }),
      setTelemetryEnabled: (enabled) => set({ telemetryEnabled: enabled }),
      setErrorReportingEnabled: (enabled) => set({ errorReportingEnabled: enabled }),
      setLspEnabled: (v) => set({ lspEnabled: v }),
      setCostTrackingEnabled: (v) => set({ costTrackingEnabled: v }),
      setSessionBudgetUsd: (v) => set({ sessionBudgetUsd: Math.max(0, v) }),
      setShowGitPanel: (enabled) => set({ showGitPanel: enabled }),
      setShowFileTree: (enabled) => set({ showFileTree: enabled }),

      // Terminal appearance setters (issue #21). Numeric setters clamp at the
      // store boundary so out-of-range values from any caller (UI or restored
      // persisted state) can't poison xterm options.
      setTerminalFontFamily: (font) => set({ terminalFontFamily: font || DEFAULT_TERMINAL_FONT_FAMILY }),
      setTerminalFontSize: (size) => set({ terminalFontSize: Math.max(8, Math.min(32, Math.round(size))) }),
      setTerminalLineHeight: (height) => set({ terminalLineHeight: Math.max(1.0, Math.min(2.0, Math.round(height * 10) / 10)) }),
      setTerminalCursorStyle: (style) => set({ terminalCursorStyle: style }),
      setTerminalCursorBlink: (enabled) => set({ terminalCursorBlink: enabled }),
      setTerminalScrollback: (lines) => set({ terminalScrollback: Math.max(100, Math.min(1000000, Math.round(lines))) }),
      setTerminalTheme: (theme) => set({ terminalTheme: theme }),
      setTerminalBidi: (enabled) => set({ terminalBidi: enabled }),
      setTerminalScrollbarMode: (mode) => set({ terminalScrollbarMode: mode }),

      // Appearance & Behavior setters (NEW v1.22.0).
      // Numeric setters clamp; string setters validate shape and fall back.
      setThemeMode: (mode) => set({ themeMode: mode }),
      setUiDensity: (density) => set({ uiDensity: density }),
      setTabHeight: (h) => set({ tabHeight: h }),
      setAccentColorHex: (hex) => {
        const ok = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex);
        set({ accentColorHex: ok ? hex : DEFAULT_ACCENT_COLOR });
      },
      setUiFontScale: (scale) =>
        set({ uiFontScale: Math.max(0.85, Math.min(1.25, Math.round(scale * 100) / 100)) }),
      setUiReduceMotion: (enabled) => set({ uiReduceMotion: enabled, uiReduceMotionUserSet: true }),
      setShowStatusBar: (v) => set({ showStatusBar: v }),
      setShowTabActivity: (v) => set({ showTabActivity: v }),
      setCompactTitleBar: (v) => set({ compactTitleBar: v }),
      setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
      setDndEnabled: (enabled) => set({ dndEnabled: enabled }),
      setDndStart: (hhmm) => set({ dndStart: /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '22:00' }),
      setDndEnd: (hhmm) => set({ dndEnd: /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '08:00' }),
      setSessionAutoSaveIntervalSec: (sec) =>
        set({ sessionAutoSaveIntervalSec: Math.max(10, Math.min(600, Math.round(sec))) }),
      setConfirmOnAppClose: (enabled) => set({ confirmOnAppClose: enabled }),

      // Editor setters (NEW v1.22.0)
      setEditorTabSize: (size) =>
        set({ editorTabSize: Math.max(1, Math.min(8, Math.round(size))) }),
      setEditorRenderWhitespace: (enabled) => set({ editorRenderWhitespace: enabled }),
      setEditorWordWrap: (enabled) => set({ editorWordWrap: enabled }),
      setEditorMinimap: (enabled) => set({ editorMinimap: enabled }),
      setEditorAutoSaveOnBlur: (enabled) => set({ editorAutoSaveOnBlur: enabled }),
      setEditorFontFamily: (family) =>
        set({ editorFontFamily: family || DEFAULT_EDITOR_FONT_FAMILY }),
      setEditorFontSize: (size) =>
        set({ editorFontSize: Math.max(8, Math.min(32, Math.round(size))) }),
      setEditorLineHeight: (height) =>
        set({ editorLineHeight: Math.max(1.0, Math.min(2.0, Math.round(height * 10) / 10)) }),

      // Terminal behavior setters (NEW v1.22.0)
      setTerminalShellPathOverride: (path) => set({ terminalShellPathOverride: path }),
      setTerminalCopyOnSelect: (enabled) => set({ terminalCopyOnSelect: enabled }),
      setTerminalPasteShortcut: (s) => set({ terminalPasteShortcut: s }),

      // VCS setters (NEW v1.22.0)
      setVcsCommitMessageTemplate: (template) => set({ vcsCommitMessageTemplate: template }),
      setVcsDefaultAutoStage: (mode) => set({ vcsDefaultAutoStage: mode }),
      setVcsDefaultMergeStrategy: (strategy) => set({ vcsDefaultMergeStrategy: strategy }),
      setVcsChangelistsConfirmDelete: (enabled) => set({ vcsChangelistsConfirmDelete: enabled }),

      // Claude setters (NEW v1.22.0)
      setClaudeDefaultModel: (model) => set({ claudeDefaultModel: model }),
      setClaudeBinaryPathOverride: (path) => set({ claudeBinaryPathOverride: path }),

      setPinnedRepoPath: (path) => set({ pinnedRepoPath: path }),
      setExplorerHeightRatio: (ratio) => set({
        explorerHeightRatio: Math.max(0.15, Math.min(0.85, ratio)),
      }),
      setRepositoriesHeightRatio: (ratio) => set({
        repositoriesHeightRatio: Math.max(0.15, Math.min(0.85, ratio)),
      }),
      toggleToolsCollapsed: () => set((state) => ({ toolsCollapsed: !state.toolsCollapsed })),
      toggleSessionsCollapsed: () => set((state) => ({ sessionsCollapsed: !state.sessionsCollapsed })),
      toggleExplorerCollapsed: () => set((state) => ({ explorerCollapsed: !state.explorerCollapsed })),
      setSessionsHeightRatio: (ratio) =>
        set({ sessionsHeightRatio: Math.max(0.15, Math.min(0.85, ratio)) }),

      openGlobalSearch: () => set({ globalSearchOpen: true }),
      closeGlobalSearch: () => set({ globalSearchOpen: false }),
      toggleGlobalSearch: () => set((state) => ({ globalSearchOpen: !state.globalSearchOpen })),

      setActiveFilePath: (path) => set({ activeFilePath: path }),

      setFileTabContent: (path, content) => set((state) => ({
        openFiles: state.openFiles.map((t) =>
          t.path === path ? { ...t, content } : t
        ),
      })),

      setFileTabError: (path, error) => set((state) => ({
        openFiles: state.openFiles.map((t) =>
          t.path === path ? { ...t, error, loading: false } : t
        ),
      })),

      openFileTab: async (path) => {
        const existing = (useAppStore.getState().openFiles).find((t) => t.path === path);
        if (existing) {
          set({ activeFilePath: path });
          return;
        }
        set((state) => ({
          openFiles: [
            ...state.openFiles,
            { path, content: '', original: '', loading: true, saving: false, error: null, mode: 'edit', headContent: '', repoRoot: null, relativePath: null },
          ],
          activeFilePath: path,
        }));
        try {
          const text = await invoke<string>('read_text_file', { path });
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, content: text, original: text, loading: false, error: null } : t
            ),
          }));
        } catch (err) {
          const message = typeof err === 'string' ? err : 'Failed to read file';
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, loading: false, error: message } : t
            ),
          }));
        }
      },

      openDiffTab: async (path, repoRoot, relativePath) => {
        // If already open, just switch into diff mode (fetch HEAD if not loaded).
        const existing = useAppStore.getState().openFiles.find((t) => t.path === path);
        if (existing) {
          set({ activeFilePath: path });
          // Ensure repo context + mode are set so the toggle works.
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path
                ? { ...t, mode: 'diff', repoRoot, relativePath }
                : t
            ),
          }));
          // If HEAD content hasn't been fetched yet, grab it.
          if (!existing.repoRoot) {
            try {
              const head = await invoke<string>('get_git_head_content', { path: repoRoot, file: relativePath });
              set((state) => ({
                openFiles: state.openFiles.map((t) =>
                  t.path === path ? { ...t, headContent: head } : t
                ),
              }));
            } catch {
              // Non-fatal - leave headContent empty; diff will render against "".
            }
          }
          return;
        }
        // Fresh open: fetch both sides in parallel so the diff appears in one render.
        set((state) => ({
          openFiles: [
            ...state.openFiles,
            { path, content: '', original: '', loading: true, saving: false, error: null, mode: 'diff', headContent: '', repoRoot, relativePath },
          ],
          activeFilePath: path,
        }));
        try {
          const [text, head] = await Promise.all([
            invoke<string>('read_text_file', { path }),
            invoke<string>('get_git_head_content', { path: repoRoot, file: relativePath }).catch(() => ''),
          ]);
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, content: text, original: text, headContent: head, loading: false, error: null } : t
            ),
          }));
        } catch (err) {
          const message = typeof err === 'string' ? err : 'Failed to read file';
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, loading: false, error: message } : t
            ),
          }));
        }
      },

      setFileTabMode: (path, mode) => set((state) => ({
        openFiles: state.openFiles.map((t) =>
          t.path === path ? { ...t, mode } : t
        ),
      })),

      closeFileTab: (path) => set((state) => {
        const idx = state.openFiles.findIndex((t) => t.path === path);
        if (idx === -1) return state;
        const nextFiles = state.openFiles.filter((t) => t.path !== path);
        let nextActive = state.activeFilePath;
        if (state.activeFilePath === path) {
          // Move focus to the next tab in order, or the previous if we closed the last.
          if (nextFiles.length === 0) {
            nextActive = null;
          } else {
            const fallbackIdx = Math.min(idx, nextFiles.length - 1);
            nextActive = nextFiles[fallbackIdx].path;
          }
        }
        return { openFiles: nextFiles, activeFilePath: nextActive };
      }),

      saveFileTab: async (path) => {
        const tab = useAppStore.getState().openFiles.find((t) => t.path === path);
        if (!tab || tab.saving) return;
        set((state) => ({
          openFiles: state.openFiles.map((t) =>
            t.path === path ? { ...t, saving: true } : t
          ),
        }));
        try {
          await invoke('write_text_file', { path, content: tab.content });
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, saving: false, original: tab.content, error: null } : t
            ),
            // Refresh the git changes panel so new saves show up.
            changesRefreshTrigger: state.changesRefreshTrigger + 1,
          }));
        } catch (err) {
          const message = typeof err === 'string' ? err : 'Failed to save file';
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, saving: false, error: message } : t
            ),
          }));
          throw err;
        }
      },

      reloadFileTab: async (path) => {
        set((state) => ({
          openFiles: state.openFiles.map((t) =>
            t.path === path ? { ...t, loading: true, error: null } : t
          ),
        }));
        try {
          const text = await invoke<string>('read_text_file', { path });
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, content: text, original: text, loading: false, error: null } : t
            ),
          }));
        } catch (err) {
          const message = typeof err === 'string' ? err : 'Failed to read file';
          set((state) => ({
            openFiles: state.openFiles.map((t) =>
              t.path === path ? { ...t, loading: false, error: message } : t
            ),
          }));
        }
      },

      // Grid actions
      toggleGridMode: () => set((state) => ({ gridMode: !state.gridMode })),
      setGridMode: (enabled) => set({ gridMode: enabled }),
      addToGrid: (terminalId) => set((state) => {
        if (state.gridTerminalIds.includes(terminalId)) return state;
        if (state.gridTerminalIds.length >= MAX_GRID_TERMINALS) return state;
        const newIds = [...state.gridTerminalIds, terminalId];
        return {
          gridTerminalIds: newIds,
          gridLayout: getOptimalLayout(newIds.length),
        };
      }),
      removeFromGrid: (terminalId) => set((state) => {
        const newIds = state.gridTerminalIds.filter(id => id !== terminalId);
        return {
          gridTerminalIds: newIds,
          gridLayout: getOptimalLayout(newIds.length),
          gridFocusedIndex: state.gridFocusedIndex !== null && state.gridFocusedIndex >= newIds.length
            ? null
            : state.gridFocusedIndex,
        };
      }),
      setGridTerminals: (terminalIds) => set({
        gridTerminalIds: terminalIds.slice(0, MAX_GRID_TERMINALS),
        gridLayout: getOptimalLayout(Math.min(terminalIds.length, MAX_GRID_TERMINALS)),
      }),
      setGridLayout: (layout) => set({ gridLayout: layout }),
      setGridFocusedIndex: (index) => set({ gridFocusedIndex: index }),
      clearGrid: () => set({
        gridTerminalIds: [],
        gridLayout: '1x1',
        gridFocusedIndex: null,
        gridMode: false,
      }),
      swapGridPositions: (fromIndex, toIndex) => set((state) => {
        const newIds = [...state.gridTerminalIds];
        if (fromIndex < 0 || fromIndex >= newIds.length || toIndex < 0 || toIndex >= newIds.length) return state;
        [newIds[fromIndex], newIds[toIndex]] = [newIds[toIndex], newIds[fromIndex]];
        return { gridTerminalIds: newIds };
      }),
      replaceInGrid: (index, terminalId) => set((state) => {
        const newIds = [...state.gridTerminalIds];
        if (index < 0 || index >= newIds.length) return state;
        if (newIds.includes(terminalId)) return state;
        newIds[index] = terminalId;
        return { gridTerminalIds: newIds };
      }),

      // Pinned-tab actions. Delegate to the pure helpers in src/lib/pinnedTabs.ts
      // so the toggling logic is unit-tested independently of Zustand hydration.
      pinTab: (id) => set((s) => ({ pinnedTabIds: addPin(s.pinnedTabIds, id) })),
      unpinTab: (id) => set((s) => ({ pinnedTabIds: removePin(s.pinnedTabIds, id) })),
      toggleTabPin: (id) => set((s) => ({ pinnedTabIds: togglePin(s.pinnedTabIds, id) })),

      // Command Palette actions (F1)
      recordPaletteUse: (key) =>
        set((s) => {
          // Cap the persisted map so orphaned keys (e.g. snippet:<id> for a
          // deleted snippet) can't accumulate forever toward the localStorage
          // quota. Keep the most-recently-used entries.
          const MAX_PALETTE_USAGE = 300;
          const next: Record<string, { count: number; lastUsedTs: number }> = {
            ...s.paletteUsage,
            [key]: { count: (s.paletteUsage[key]?.count ?? 0) + 1, lastUsedTs: Date.now() },
          };
          const keys = Object.keys(next);
          if (keys.length <= MAX_PALETTE_USAGE) return { paletteUsage: next };
          const kept = keys
            .sort((a, b) => next[b].lastUsedTs - next[a].lastUsedTs)
            .slice(0, MAX_PALETTE_USAGE);
          const trimmed: Record<string, { count: number; lastUsedTs: number }> = {};
          for (const k of kept) trimmed[k] = next[k];
          return { paletteUsage: trimmed };
        }),
      openCommandPalette: () => set({ commandPaletteOpen: true }),
      closeCommandPalette: () => set({ commandPaletteOpen: false }),
      toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      // Session History actions (F2)
      openSessionHistory: () => set({ sessionHistoryOpen: true }),
      closeSessionHistory: () => set({ sessionHistoryOpen: false }),

      // Crash Recovery actions (F3)
      setShowRestoreBanner: (show) => set({ showRestoreBanner: show }),
      setPendingRestoreConfigs: (configs) => set({ pendingRestoreConfigs: configs }),

      // Split Pane actions (Ctrl+\)
      toggleSplitMode: () => set((state) => ({ splitMode: !state.splitMode })),
      setSplitMode: (enabled) => set({ splitMode: enabled }),
      setSplitTerminals: (ids) => set({ splitTerminalIds: ids }),
      setSplitOrientation: (orientation) => set({ splitOrientation: orientation }),
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
      clearSplit: () => set({ splitMode: false, splitTerminalIds: null, splitRatio: 0.5 }),

      // Agent Teams actions (F4)
      toggleOrchestration: () => set((state) => ({ orchestrationOpen: !state.orchestrationOpen })),

      // Snippets actions (F5)
      openSnippetsModal: () => set({ snippetsModalOpen: true }),
      closeSnippetsModal: () => set({ snippetsModalOpen: false }),

      // Claude Config actions (F6)
      openClaudeConfig: () => set({ claudeConfigOpen: true }),
      closeClaudeConfig: () => set({ claudeConfigOpen: false }),

      // Session Timeline actions (F7)
      openSessionTimeline: () => set({ sessionTimelineOpen: true }),
      closeSessionTimeline: () => set({ sessionTimelineOpen: false }),
      toggleSessionTimeline: () => set((state) => ({ sessionTimelineOpen: !state.sessionTimelineOpen })),

      // Memory Editor actions (F8)
      openMemoryEditor: () => set({ memoryEditorOpen: true }),
      closeMemoryEditor: () => set({ memoryEditorOpen: false }),

      // What's New actions
      openWhatsNew: () => set({ whatsNewOpen: true }),
      closeWhatsNew: () => set({ whatsNewOpen: false }),
      setLastSeenVersion: (version) => set({ lastSeenVersion: version }),

      // Paste-as-File actions
      openPasteDrawer: (seed) => set({
        pasteDrawerOpen: true,
        pasteDrawerSeed: seed
          ? { content: seed.content ?? '', targetTerminalId: seed.targetTerminalId ?? null }
          : null,
      }),
      closePasteDrawer: () => set({ pasteDrawerOpen: false, pasteDrawerSeed: null }),
      setPasteAutoDetectEnabled: (enabled) => set({ pasteAutoDetectEnabled: enabled }),
      setPasteAutoDetectThresholdBytes: (n) => set({ pasteAutoDetectThresholdBytes: Math.max(256, n) }),
      setPasteAutoDetectThresholdLines: (n) => set({ pasteAutoDetectThresholdLines: Math.max(5, n) }),
      setPastePromptTemplate: (s) => set({ pastePromptTemplate: s }),
      setPasteRetention: (r) => set({ pasteRetention: r }),
      setPasteRetentionDays: (n) => set({ pasteRetentionDays: Math.max(1, n) }),

      // Prompt Editor actions
      openPromptEditor: (terminalId, seedText) => set({
        promptEditorOpen: true,
        promptEditorTargetId: terminalId ?? null,
        promptEditorSeed: seedText ?? null,
      }),
      closePromptEditor: () => set({ promptEditorOpen: false }),
      setPromptDraft: (terminalId, text) => set((state) => ({
        promptDrafts: { ...state.promptDrafts, [terminalId]: text },
      })),
      clearPromptDraft: (terminalId) => set((state) => {
        if (!(terminalId in state.promptDrafts)) return {};
        const next = { ...state.promptDrafts };
        delete next[terminalId];
        return { promptDrafts: next };
      }),
      setPromptEditorShortcutEnabled: (enabled) => set({ promptEditorShortcutEnabled: enabled }),
    }),
    {
      name: 'claude-terminal-app',
      version: 2,
      migrate: (persistedState, version) => {
        const s = (persistedState as Partial<AppState>) ?? {};
        if (version < 1) {
          // Force cost tracking OFF for users who upgraded from a build where
          // it defaulted to true. New default is false; opt-in only.
          s.costTrackingEnabled = false;
        }
        if (version < 2) {
          // v1.26.1: restore native Ctrl+V paste. The 'ctrl+shift+v' default
          // was persisted since v1.22 but dormant (ignored by the Ctrl+V
          // handler) until v1.25 started honoring it - which silently turned
          // plain Ctrl+V into a raw ^V byte instead of a paste for everyone who
          // never explicitly chose 'ctrl+v'. Reset it so paste works again.
          s.terminalPasteShortcut = 'ctrl+v';
        }
        return s as AppState;
      },
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarCollapsed: state.sidebarCollapsed,
        hintsOpen: state.hintsOpen,
        changesOpen: state.changesOpen,
        defaultClaudeArgs: state.defaultClaudeArgs,
        notifyOnFinish: state.notifyOnFinish,
        restoreSession: state.restoreSession,
        telemetryEnabled: state.telemetryEnabled,
        errorReportingEnabled: state.errorReportingEnabled,
        lspEnabled: state.lspEnabled,
        costTrackingEnabled: state.costTrackingEnabled,
        sessionBudgetUsd: state.sessionBudgetUsd,
        showGitPanel: state.showGitPanel,
        showFileTree: state.showFileTree,
        terminalFontFamily: state.terminalFontFamily,
        terminalFontSize: state.terminalFontSize,
        terminalLineHeight: state.terminalLineHeight,
        terminalCursorStyle: state.terminalCursorStyle,
        terminalCursorBlink: state.terminalCursorBlink,
        terminalScrollback: state.terminalScrollback,
        terminalTheme: state.terminalTheme,
        terminalBidi: state.terminalBidi,
        terminalScrollbarMode: state.terminalScrollbarMode,
        explorerHeightRatio: state.explorerHeightRatio,
        toolsCollapsed: state.toolsCollapsed,
        sessionsCollapsed: state.sessionsCollapsed,
        explorerCollapsed: state.explorerCollapsed,
        sessionsHeightRatio: state.sessionsHeightRatio,
        repositoriesHeightRatio: state.repositoriesHeightRatio,
        orchestrationOpen: state.orchestrationOpen,
        lastSeenVersion: state.lastSeenVersion,
        pasteAutoDetectEnabled: state.pasteAutoDetectEnabled,
        pasteAutoDetectThresholdBytes: state.pasteAutoDetectThresholdBytes,
        pasteAutoDetectThresholdLines: state.pasteAutoDetectThresholdLines,
        pastePromptTemplate: state.pastePromptTemplate,
        pasteRetention: state.pasteRetention,
        pasteRetentionDays: state.pasteRetentionDays,
        promptEditorShortcutEnabled: state.promptEditorShortcutEnabled,

        // Appearance & Behavior (NEW v1.22.0)
        themeMode: state.themeMode,
        uiDensity: state.uiDensity,
        tabHeight: state.tabHeight,
        accentColorHex: state.accentColorHex,
        uiFontScale: state.uiFontScale,
        uiReduceMotion: state.uiReduceMotion,
        uiReduceMotionUserSet: state.uiReduceMotionUserSet,
        paletteUsage: state.paletteUsage,
        showStatusBar: state.showStatusBar,
        showTabActivity: state.showTabActivity,
        compactTitleBar: state.compactTitleBar,
        notificationSoundEnabled: state.notificationSoundEnabled,
        dndEnabled: state.dndEnabled,
        dndStart: state.dndStart,
        dndEnd: state.dndEnd,
        sessionAutoSaveIntervalSec: state.sessionAutoSaveIntervalSec,
        confirmOnAppClose: state.confirmOnAppClose,

        // Editor (NEW v1.22.0)
        editorTabSize: state.editorTabSize,
        editorRenderWhitespace: state.editorRenderWhitespace,
        editorWordWrap: state.editorWordWrap,
        editorMinimap: state.editorMinimap,
        editorAutoSaveOnBlur: state.editorAutoSaveOnBlur,
        editorFontFamily: state.editorFontFamily,
        editorFontSize: state.editorFontSize,
        editorLineHeight: state.editorLineHeight,

        // Terminal behavior (NEW v1.22.0)
        terminalShellPathOverride: state.terminalShellPathOverride,
        terminalCopyOnSelect: state.terminalCopyOnSelect,
        terminalPasteShortcut: state.terminalPasteShortcut,

        // VCS (NEW v1.22.0)
        vcsCommitMessageTemplate: state.vcsCommitMessageTemplate,
        vcsDefaultAutoStage: state.vcsDefaultAutoStage,
        vcsDefaultMergeStrategy: state.vcsDefaultMergeStrategy,
        vcsChangelistsConfirmDelete: state.vcsChangelistsConfirmDelete,

        // Claude (NEW v1.22.0)
        claudeDefaultModel: state.claudeDefaultModel,
        claudeBinaryPathOverride: state.claudeBinaryPathOverride,

        // Pinned tabs (Phase 4a). Persist pinned-tab intent WITHIN a session
        // so refreshes / new detached windows preserve the pin state.
        // Restored terminals get fresh UUIDs (Uuid::new_v4() in Rust), so
        // pins do NOT survive app restart — see the startup GC in App.tsx
        // that drops ghost ids after session restore populates the store.
        // A stable-key persistence pass (using working_directory +
        // claude_session_id) is queued as a follow-up.
        pinnedTabIds: state.pinnedTabIds,
      }),
    }
  )
);
