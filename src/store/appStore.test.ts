import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ''),
}));

import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  getOptimalLayout,
  useAppStore,
} from './appStore';

const PERSIST_KEY = 'claude-terminal-app';

function resetAppStore() {
  useAppStore.setState({
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
    defaultClaudeArgs: [],
    defaultAgentArgs: { claude: [], codex: [], cursor: [], antigravity: [] },
    notifyOnFinish: true,
    restoreSession: true,
    telemetryEnabled: true,
    errorReportingEnabled: true,
    showGitPanel: true,
    showFileTree: true,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
    terminalLineHeight: 1.2,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: true,
    terminalScrollback: 50000,
    terminalTheme: 'dark',
    terminalBidi: false,
    changesRefreshTrigger: 0,
    pinnedRepoPath: null,
    openFiles: [],
    activeFilePath: null,
    editorNavigationTarget: null,
    editorNavigationSequence: 0,
    explorerHeightRatio: 0.45,
    toolsCollapsed: true,
    repositoriesHeightRatio: 0.35,
    globalSearchOpen: false,
    gridMode: false,
    gridTerminalIds: [],
    gridLayout: '1x1',
    gridFocusedIndex: null,
    commandPaletteOpen: false,
    sessionHistoryOpen: false,
    showRestoreBanner: false,
    pendingRestoreConfigs: null,
    splitMode: false,
    splitTerminalIds: null,
    splitOrientation: 'horizontal',
    splitRatio: 0.5,
    orchestrationOpen: false,
    snippetsModalOpen: false,
    claudeConfigOpen: false,
    sessionTimelineOpen: false,
    memoryEditorOpen: false,
    whatsNewOpen: false,
    lastSeenVersion: null,
    pasteDrawerOpen: false,
    pasteDrawerSeed: null,
    pasteAutoDetectEnabled: true,
    pasteAutoDetectThresholdBytes: 4096,
    pasteAutoDetectThresholdLines: 50,
    pastePromptTemplate: 'Please look at @{path}',
    pasteRetention: 'close',
    pasteRetentionDays: 7,

    // Appearance & Behavior (NEW v1.22.0)
    themeMode: 'dark',
    uiDensity: 'comfortable',
    tabHeight: 'medium',
    colorfulFolderIcons: false,
    accentColorHex: '#0A84FF',
    uiFontScale: 1.0,
    uiReduceMotion: false,
    notificationSoundEnabled: false,
    dndEnabled: false,
    dndStart: '22:00',
    dndEnd: '08:00',
    sessionAutoSaveIntervalSec: 30,
    confirmOnAppClose: true,
    // Editor (NEW v1.22.0)
    editorTabSize: 2,
    editorRenderWhitespace: false,
    editorWordWrap: true,
    editorMinimap: false,
    editorAutoSaveOnBlur: false,
    editorFontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    editorFontSize: 13,
    editorLineHeight: 1.5,
    // Terminal behavior (NEW v1.22.0)
    terminalShellPathOverride: '',
    terminalCopyOnSelect: false,
    terminalPasteShortcut: 'ctrl+shift+v',
    // VCS (NEW v1.22.0)
    vcsCommitMessageTemplate: '',
    vcsDefaultAutoStage: 'none',
    vcsDefaultMergeStrategy: 'merge',
    vcsChangelistsConfirmDelete: true,
    // Claude (NEW v1.22.0)
    claudeDefaultModel: null,
    claudeBinaryPathOverride: '',
  });
}

beforeEach(() => {
  localStorage.clear();
  resetAppStore();
});

afterEach(() => {
  localStorage.clear();
});

describe('getOptimalLayout', () => {
  it.each([
    [1, '1x1'],
    [2, '1x2'],
    [3, '1x3'],
    [4, '2x2'],
    [5, '2x3'],
    [6, '2x3'],
    [7, '2x4'],
    [8, '2x4'],
    [0, '1x1'],
    [99, '1x1'],
  ])('count=%i → %s', (count, layout) => {
    expect(getOptimalLayout(count)).toBe(layout);
  });
});

describe('appStore - terminal appearance clamping', () => {
  it('setTerminalFontSize clamps to 8..32 and rounds', () => {
    const { setTerminalFontSize } = useAppStore.getState();

    setTerminalFontSize(2);
    expect(useAppStore.getState().terminalFontSize).toBe(8);

    setTerminalFontSize(99);
    expect(useAppStore.getState().terminalFontSize).toBe(32);

    setTerminalFontSize(15.7);
    expect(useAppStore.getState().terminalFontSize).toBe(16);
  });

  it('setTerminalLineHeight clamps to 1.0..2.0 with one-decimal rounding', () => {
    const { setTerminalLineHeight } = useAppStore.getState();

    setTerminalLineHeight(0.5);
    expect(useAppStore.getState().terminalLineHeight).toBe(1.0);

    setTerminalLineHeight(3);
    expect(useAppStore.getState().terminalLineHeight).toBe(2.0);

    setTerminalLineHeight(1.45);
    // 1.45 → round(14.5) = 15 → 1.5 (browsers round half-to-even can vary, but
    // Math.round on 14.5 is 15 in V8/JSC).
    expect(useAppStore.getState().terminalLineHeight).toBeCloseTo(1.5, 5);
  });

  it('setTerminalScrollback clamps to 100..1_000_000', () => {
    const { setTerminalScrollback } = useAppStore.getState();

    setTerminalScrollback(0);
    expect(useAppStore.getState().terminalScrollback).toBe(100);

    setTerminalScrollback(10_000_000);
    expect(useAppStore.getState().terminalScrollback).toBe(1_000_000);

    setTerminalScrollback(7500.4);
    expect(useAppStore.getState().terminalScrollback).toBe(7500);
  });

  it('setTerminalFontFamily falls back to default when given an empty string', () => {
    const { setTerminalFontFamily } = useAppStore.getState();
    setTerminalFontFamily('');
    expect(useAppStore.getState().terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);

    setTerminalFontFamily('Monaco');
    expect(useAppStore.getState().terminalFontFamily).toBe('Monaco');
  });

  it('setSplitRatio clamps to 0.2..0.8', () => {
    const { setSplitRatio } = useAppStore.getState();
    setSplitRatio(0);
    expect(useAppStore.getState().splitRatio).toBe(0.2);
    setSplitRatio(1);
    expect(useAppStore.getState().splitRatio).toBe(0.8);
    setSplitRatio(0.4);
    expect(useAppStore.getState().splitRatio).toBe(0.4);
  });

  it('setExplorerHeightRatio / setRepositoriesHeightRatio clamp to 0.15..0.85', () => {
    const { setExplorerHeightRatio, setRepositoriesHeightRatio } = useAppStore.getState();
    setExplorerHeightRatio(0);
    expect(useAppStore.getState().explorerHeightRatio).toBe(0.15);
    setExplorerHeightRatio(1);
    expect(useAppStore.getState().explorerHeightRatio).toBe(0.85);

    setRepositoriesHeightRatio(0);
    expect(useAppStore.getState().repositoriesHeightRatio).toBe(0.15);
    setRepositoriesHeightRatio(1);
    expect(useAppStore.getState().repositoriesHeightRatio).toBe(0.85);
  });
});

describe('appStore - grid actions', () => {
  it('addToGrid dedupes and caps at 8', () => {
    const { addToGrid } = useAppStore.getState();
    for (let i = 0; i < 10; i++) addToGrid(`t${i}`);
    addToGrid('t0'); // duplicate

    const ids = useAppStore.getState().gridTerminalIds;
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it('addToGrid auto-selects the optimal layout', () => {
    const { addToGrid } = useAppStore.getState();
    addToGrid('a');
    addToGrid('b');
    addToGrid('c');
    addToGrid('d');
    expect(useAppStore.getState().gridLayout).toBe('2x2');
  });

  it('addToGrid preserves the current layout when it still has capacity', () => {
    // Bug from GH #52.3: picking 2x2 then adding a 3rd terminal used to
    // silently switch the layout to 1x3. Now the user's manual choice
    // stays until the layout is actually full.
    useAppStore.setState({ gridTerminalIds: ['a', 'b'], gridLayout: '2x2' });
    useAppStore.getState().addToGrid('c');
    const state = useAppStore.getState();
    expect(state.gridTerminalIds).toEqual(['a', 'b', 'c']);
    expect(state.gridLayout).toBe('2x2');
  });

  it('addToGrid grows the layout only when the current one is full', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b'], gridLayout: '1x2' });
    useAppStore.getState().addToGrid('c');
    // 1x2 holds 2 tabs; adding a 3rd must grow the layout.
    expect(useAppStore.getState().gridLayout).toBe('1x3');
  });

  it('removeFromGrid clears focused index when it falls out of range', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b', 'c'], gridFocusedIndex: 2 });

    useAppStore.getState().removeFromGrid('c');

    const state = useAppStore.getState();
    expect(state.gridTerminalIds).toEqual(['a', 'b']);
    expect(state.gridFocusedIndex).toBeNull();
  });

  it('removeFromGrid keeps focused index when still in range', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b', 'c'], gridFocusedIndex: 0 });

    useAppStore.getState().removeFromGrid('c');

    expect(useAppStore.getState().gridFocusedIndex).toBe(0);
  });

  it('swapGridPositions swaps in place and ignores out-of-range indices', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b', 'c'] });

    useAppStore.getState().swapGridPositions(0, 2);
    expect(useAppStore.getState().gridTerminalIds).toEqual(['c', 'b', 'a']);

    useAppStore.getState().swapGridPositions(0, 99);
    expect(useAppStore.getState().gridTerminalIds).toEqual(['c', 'b', 'a']);
  });

  it('replaceInGrid is a no-op when target id is already present', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b', 'c'] });

    useAppStore.getState().replaceInGrid(0, 'b');

    expect(useAppStore.getState().gridTerminalIds).toEqual(['a', 'b', 'c']);
  });

  it('replaceInGrid swaps the entry when the target id is fresh', () => {
    useAppStore.setState({ gridTerminalIds: ['a', 'b', 'c'] });

    useAppStore.getState().replaceInGrid(1, 'z');

    expect(useAppStore.getState().gridTerminalIds).toEqual(['a', 'z', 'c']);
  });
});

describe('appStore - closeFileTab focus rules', () => {
  function seedFiles(paths: string[], active: string | null) {
    useAppStore.setState({
      openFiles: paths.map((p) => ({
        path: p,
        content: '',
        original: '',
        loading: false,
        saving: false,
        error: null,
        mode: 'edit',
        headContent: '',
        repoRoot: null,
        relativePath: null,
      })),
      activeFilePath: active,
    });
  }

  it('moves focus to the next tab in order when an earlier tab closes', () => {
    seedFiles(['a', 'b', 'c'], 'a');
    useAppStore.getState().closeFileTab('a');
    expect(useAppStore.getState().activeFilePath).toBe('b');
  });

  it('moves focus to the previous tab when the last tab closes', () => {
    seedFiles(['a', 'b', 'c'], 'c');
    useAppStore.getState().closeFileTab('c');
    expect(useAppStore.getState().activeFilePath).toBe('b');
  });

  it('clears active path when the only tab closes', () => {
    seedFiles(['a'], 'a');
    useAppStore.getState().closeFileTab('a');
    expect(useAppStore.getState().activeFilePath).toBeNull();
  });

  it('leaves active path untouched when closing a non-active tab', () => {
    seedFiles(['a', 'b'], 'a');
    useAppStore.getState().closeFileTab('b');
    expect(useAppStore.getState().activeFilePath).toBe('a');
  });
});

describe('appStore - editor navigation', () => {
  it('normalizes coordinates and ignores stale clear requests', () => {
    const store = useAppStore.getState();
    store.requestEditorNavigation('a.ts', 0, -4);
    const first = useAppStore.getState().editorNavigationTarget!;
    expect(first).toMatchObject({ path: 'a.ts', line: 1, column: 1 });

    useAppStore.getState().requestEditorNavigation('b.ts', 12.8, 7.9);
    const second = useAppStore.getState().editorNavigationTarget!;
    expect(second).toMatchObject({ path: 'b.ts', line: 12, column: 7 });
    expect(second.requestId).toBeGreaterThan(first.requestId);

    useAppStore.getState().clearEditorNavigation(first.requestId);
    expect(useAppStore.getState().editorNavigationTarget).toEqual(second);

    useAppStore.getState().clearEditorNavigation(second.requestId);
    expect(useAppStore.getState().editorNavigationTarget).toBeNull();
  });
});

describe('appStore - persist partialize', () => {
  // Regression guard: every key in this allow-list belongs in the persisted
  // shape. Adding a new persisted key requires updating both this list and
  // partialize() in appStore.ts. Adding a non-persisted key here without
  // updating partialize() catches the inverse mistake.
  const PERSISTED_KEYS = [
    'sidebarOpen',
    'sidebarCollapsed',
    'hintsOpen',
    'changesOpen',
    'defaultClaudeArgs',
    'defaultAgentArgs',
    'notifyOnFinish',
    'restoreSession',
    'telemetryEnabled',
    'errorReportingEnabled',
    'costTrackingEnabled',
    'sessionBudgetUsd',
    'showGitPanel',
    'showFileTree',
    'terminalFontFamily',
    'terminalFontSize',
    'terminalLineHeight',
    'terminalCursorStyle',
    'terminalCursorBlink',
    'terminalScrollback',
    'terminalScrollbarMode',
    'terminalTheme',
    'terminalBidi',
    'explorerHeightRatio',
    'toolsCollapsed',
    'sessionsCollapsed',
    'explorerCollapsed',
    'sessionsHeightRatio',
    'repositoriesHeightRatio',
    'orchestrationOpen',
    'lastSeenVersion',
    'lspEnabled',
    'pasteAutoDetectEnabled',
    'pasteAutoDetectThresholdBytes',
    'pasteAutoDetectThresholdLines',
    'pastePromptTemplate',
    'pasteRetention',
    'pasteRetentionDays',
    'promptEditorShortcutEnabled',
    // Appearance & Behavior (NEW v1.22.0)
    'themeMode',
    'uiDensity',
    'tabHeight',
    'colorfulFolderIcons',
    'accentColorHex',
    'uiFontScale',
    'uiReduceMotion',
    'uiReduceMotionUserSet',
    'paletteUsage',
    'showStatusBar',
    'showTabActivity',
    'compactTitleBar',
    'notificationSoundEnabled',
    'dndEnabled',
    'dndStart',
    'dndEnd',
    'sessionAutoSaveIntervalSec',
    'confirmOnAppClose',
    // Editor (NEW v1.22.0)
    'editorTabSize',
    'editorRenderWhitespace',
    'editorWordWrap',
    'editorMinimap',
    'editorAutoSaveOnBlur',
    'editorFontFamily',
    'editorFontSize',
    'editorLineHeight',
    // Terminal behavior (NEW v1.22.0)
    'terminalShellPathOverride',
    'terminalCopyOnSelect',
    'terminalPasteShortcut',
    // VCS (NEW v1.22.0)
    'vcsCommitMessageTemplate',
    'vcsDefaultAutoStage',
    'vcsDefaultMergeStrategy',
    'vcsChangelistsConfirmDelete',
    // Claude (NEW v1.22.0)
    'claudeDefaultModel',
    'claudeBinaryPathOverride',
    // Pinned tabs (Phase 4a)
    'pinnedTabIds',
  ].sort();

  it('persists exactly the allow-listed keys, and no transient ones', () => {
    // Trigger a write by mutating any persisted key.
    useAppStore.getState().setSidebarCollapsed(true);

    const raw = localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!).state as Record<string, unknown>;

    expect(Object.keys(stored).sort()).toEqual(PERSISTED_KEYS);

    // Spot-check: transient UI state must not leak to disk.
    for (const key of [
      'settingsOpen',
      'newTerminalModalOpen',
      'gridMode',
      'gridTerminalIds',
      'splitMode',
      'splitTerminalIds',
      'openFiles',
      'activeFilePath',
      'showRestoreBanner',
      'pendingRestoreConfigs',
      'commandPaletteOpen',
      'globalSearchOpen',
      'promptEditorOpen',
      'promptEditorTargetId',
      'promptEditorSeed',
      'promptDrafts',
    ]) {
      expect(stored).not.toHaveProperty(key);
    }
  });
});

describe('appStore - prompt editor drafts', () => {
  beforeEach(() => {
    useAppStore.setState({ promptEditorOpen: false, promptEditorTargetId: null, promptDrafts: {} });
  });

  it('openPromptEditor sets the target and clears it on the next open', () => {
    useAppStore.getState().openPromptEditor('term-1');
    expect(useAppStore.getState().promptEditorOpen).toBe(true);
    expect(useAppStore.getState().promptEditorTargetId).toBe('term-1');

    useAppStore.getState().closePromptEditor();
    expect(useAppStore.getState().promptEditorOpen).toBe(false);

    useAppStore.getState().openPromptEditor();
    expect(useAppStore.getState().promptEditorTargetId).toBeNull();
  });

  it('setPromptDraft stores per-terminal drafts independently', () => {
    useAppStore.getState().setPromptDraft('a', 'draft for a');
    useAppStore.getState().setPromptDraft('b', 'draft for b');
    expect(useAppStore.getState().promptDrafts).toEqual({ a: 'draft for a', b: 'draft for b' });

    useAppStore.getState().setPromptDraft('a', 'updated a');
    expect(useAppStore.getState().promptDrafts.a).toBe('updated a');
    expect(useAppStore.getState().promptDrafts.b).toBe('draft for b');
  });

  it('clearPromptDraft removes only the given terminal draft', () => {
    useAppStore.getState().setPromptDraft('a', 'x');
    useAppStore.getState().setPromptDraft('b', 'y');
    useAppStore.getState().clearPromptDraft('a');
    expect(useAppStore.getState().promptDrafts).toEqual({ b: 'y' });

    // Clearing an unknown id is a harmless no-op.
    useAppStore.getState().clearPromptDraft('missing');
    expect(useAppStore.getState().promptDrafts).toEqual({ b: 'y' });
  });

  it('setPromptEditorShortcutEnabled toggles the persisted flag', () => {
    expect(useAppStore.getState().promptEditorShortcutEnabled).toBe(true);
    useAppStore.getState().setPromptEditorShortcutEnabled(false);
    expect(useAppStore.getState().promptEditorShortcutEnabled).toBe(false);
    useAppStore.getState().setPromptEditorShortcutEnabled(true);
    expect(useAppStore.getState().promptEditorShortcutEnabled).toBe(true);
  });
});

describe('appStore - appearance v1.22.0 setters', () => {
  it('setUiFontScale clamps to 0.85..1.25 with 2-decimal rounding', () => {
    const { setUiFontScale } = useAppStore.getState();
    setUiFontScale(0.5);
    expect(useAppStore.getState().uiFontScale).toBe(0.85);
    setUiFontScale(2);
    expect(useAppStore.getState().uiFontScale).toBe(1.25);
    setUiFontScale(1.075);
    expect(useAppStore.getState().uiFontScale).toBeCloseTo(1.08, 5);
  });

  it('setAccentColorHex falls back to default on invalid input', () => {
    const { setAccentColorHex } = useAppStore.getState();
    setAccentColorHex('#abc');
    expect(useAppStore.getState().accentColorHex).toBe('#abc');
    setAccentColorHex('#ABCDEF');
    expect(useAppStore.getState().accentColorHex).toBe('#ABCDEF');
    setAccentColorHex('not a color');
    expect(useAppStore.getState().accentColorHex).toBe('#0A84FF');
  });

  it('setThemeMode / setUiDensity / setUiReduceMotion set as given', () => {
    const s = useAppStore.getState();
    s.setThemeMode('light');
    expect(useAppStore.getState().themeMode).toBe('light');
    s.setUiDensity('compact');
    expect(useAppStore.getState().uiDensity).toBe('compact');
    s.setUiReduceMotion(true);
    expect(useAppStore.getState().uiReduceMotion).toBe(true);
  });

  it('recordPaletteUse increments count and stamps lastUsedTs', () => {
    const s = useAppStore.getState();
    expect(useAppStore.getState().paletteUsage['cmd:New Terminal']).toBeUndefined();

    s.recordPaletteUse('cmd:New Terminal');
    const first = useAppStore.getState().paletteUsage['cmd:New Terminal'];
    expect(first.count).toBe(1);
    expect(typeof first.lastUsedTs).toBe('number');

    s.recordPaletteUse('cmd:New Terminal');
    const second = useAppStore.getState().paletteUsage['cmd:New Terminal'];
    expect(second.count).toBe(2);
    expect(second.lastUsedTs).toBeGreaterThanOrEqual(first.lastUsedTs);
  });

  it('minimal-UI toggle setters flip status bar / tab activity / compact title bar', () => {
    const s = useAppStore.getState();
    s.setShowStatusBar(false);
    expect(useAppStore.getState().showStatusBar).toBe(false);
    s.setShowStatusBar(true);
    expect(useAppStore.getState().showStatusBar).toBe(true);

    s.setShowTabActivity(false);
    expect(useAppStore.getState().showTabActivity).toBe(false);

    s.setCompactTitleBar(true);
    expect(useAppStore.getState().compactTitleBar).toBe(true);
  });
});

describe('appStore - notifications + session v1.22.0 setters', () => {
  it('setDndStart / setDndEnd validate HH:mm shape', () => {
    const s = useAppStore.getState();
    s.setDndStart('23:30');
    expect(useAppStore.getState().dndStart).toBe('23:30');
    s.setDndStart('bogus');
    expect(useAppStore.getState().dndStart).toBe('22:00');
    s.setDndEnd('07:15');
    expect(useAppStore.getState().dndEnd).toBe('07:15');
  });

  it('setSessionAutoSaveIntervalSec clamps to 10..600', () => {
    const { setSessionAutoSaveIntervalSec } = useAppStore.getState();
    setSessionAutoSaveIntervalSec(5);
    expect(useAppStore.getState().sessionAutoSaveIntervalSec).toBe(10);
    setSessionAutoSaveIntervalSec(10_000);
    expect(useAppStore.getState().sessionAutoSaveIntervalSec).toBe(600);
    setSessionAutoSaveIntervalSec(45.6);
    expect(useAppStore.getState().sessionAutoSaveIntervalSec).toBe(46);
  });
});

describe('appStore - persist migration v3 → v4 (gemini → antigravity)', () => {
  it('rekeys defaultAgentArgs.gemini to defaultAgentArgs.antigravity on rehydrate', async () => {
    // Simulate a persisted state written by a pre-Antigravity build: the
    // legacy `gemini` slot carries the user's args, and the top-level
    // `version` is 3 (the version right before the rename shipped).
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 3,
        state: {
          defaultClaudeArgs: ['--model', 'opus'],
          defaultAgentArgs: {
            claude: ['--model', 'opus'],
            codex: ['--exec'],
            cursor: ['--print'],
            gemini: ['--yolo', '--model', 'gemini-2.5-pro'],
          },
        },
      }),
    );

    // Force a rehydrate so the migrate() chain runs against the primed
    // payload. Without this the store still holds the beforeEach reset
    // state; rehydrate swaps it for the migrated one.
    await useAppStore.persist.rehydrate();

    const args = useAppStore.getState().defaultAgentArgs;
    expect(args.antigravity).toEqual(['--yolo', '--model', 'gemini-2.5-pro']);
    expect(args.claude).toEqual(['--model', 'opus']);
    expect(args.codex).toEqual(['--exec']);
    expect(args.cursor).toEqual(['--print']);
    // The legacy key should not survive - future writes must use the new
    // shape or the persisted payload will grow stale entries forever.
    expect((args as Record<string, unknown>).gemini).toBeUndefined();
  });
});

describe('appStore - editor v1.22.0 setters', () => {
  it('setEditorTabSize clamps to 1..8 and rounds', () => {
    const { setEditorTabSize } = useAppStore.getState();
    setEditorTabSize(0);
    expect(useAppStore.getState().editorTabSize).toBe(1);
    setEditorTabSize(99);
    expect(useAppStore.getState().editorTabSize).toBe(8);
    setEditorTabSize(4.6);
    expect(useAppStore.getState().editorTabSize).toBe(5);
  });

  it('setEditorFontSize / setEditorLineHeight clamp like the terminal counterparts', () => {
    const s = useAppStore.getState();
    s.setEditorFontSize(2);
    expect(useAppStore.getState().editorFontSize).toBe(8);
    s.setEditorFontSize(99);
    expect(useAppStore.getState().editorFontSize).toBe(32);
    s.setEditorLineHeight(0.5);
    expect(useAppStore.getState().editorLineHeight).toBe(1.0);
    s.setEditorLineHeight(5);
    expect(useAppStore.getState().editorLineHeight).toBe(2.0);
  });
});
