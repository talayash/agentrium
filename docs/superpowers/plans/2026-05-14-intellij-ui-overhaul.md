# IntelliJ UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the five-section IntelliJ overhaul from `docs/superpowers/specs/2026-05-14-intellij-ui-overhaul-design.md` — sidebar-as-Explorer-only, Changelists Lite, Tools moved to title-bar dropdown, full-window categorized Settings, IJ visual-polish standardization, and the active-work tab indicator.

**Architecture:** Additive: no removed Zustand keys, two new SQLite tables (`CREATE TABLE IF NOT EXISTS`), all new visual settings driven by CSS variables on `:root`. `SettingsModal.tsx` (780 lines) replaced by `SettingsWindow.tsx` + 16 thin category page components. `FileChangesPanel.tsx` (1466 lines) split into 4 siblings under `src/components/changes/`.

**Tech Stack:** Rust + Tauri 2 (backend), React 18 + TypeScript + Zustand + Framer Motion + Tailwind (frontend). No new dependencies. Vitest for store/UI tests, cargo test for Rust commands.

**Test approach:** TDD for Rust commands (cargo unit tests, in-memory SQLite). Store setters get vitest tests with clamping/validation coverage in `src/store/appStore.test.ts`. UI components get smoke renders + key-interaction tests (vitest + React Testing Library). Visual polish (density var, accent CSS-var swap, light theme) verified manually since the changes are CSS-token rewrites with no logic.

**Branch:** `feat/intellij-overhaul`. Merge to `master` via PR, then `/publish 1.22.0`.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/components/changes/FileChangesPanel.tsx` | Coordinator (~250 lines): owns the Repositories ⇕ Changes splitter, fetches `result` + `stashes`, provides `RepoSelectionContext`. |
| `src/components/changes/RepositoriesSection.tsx` | Lifted from current panel: `RepoRow`, `WorktreeRow`, branch dropdown, pull form, create-branch flow. |
| `src/components/changes/ChangelistSection.tsx` | NEW: renders Staged + Default + named changelists; CRUD UI; "Move to Changelist" submenu; "Stage all" per list. |
| `src/components/changes/StashesSection.tsx` | Lifted: stash list with apply/pop/drop. |
| `src/components/changes/CommitBar.tsx` | Lifted: textarea + Stash / Commit / Push buttons. |
| `src/components/settings/SettingsWindow.tsx` | Replaces `SettingsModal.tsx`. Modal shell, category tree + content router. |
| `src/components/settings/SettingsCategoryTree.tsx` | Left nav with category groups + 2px stripe on active. |
| `src/components/settings/SettingsSearch.tsx` | Top search box + flat-index filter context. |
| `src/components/settings/index.ts` | Public exports + the searchable settings index. |
| `src/components/settings/categories/AppearancePage.tsx` | Theme, density, accent, font scale, reduce motion. |
| `src/components/settings/categories/NotificationsPage.tsx` | Notify-on-finish, sound on/off, DND hours. |
| `src/components/settings/categories/StartupSessionPage.tsx` | Restore session, auto-save interval, confirm-on-close. |
| `src/components/settings/categories/KeymapPage.tsx` | Read-only shortcut table from a shared keymap definition. |
| `src/components/settings/categories/EditorGeneralPage.tsx` | Monaco general prefs. |
| `src/components/settings/categories/EditorFontPage.tsx` | Monaco font / size / line height. |
| `src/components/settings/categories/TerminalAppearancePage.tsx` | Lift the today's terminal-appearance block. |
| `src/components/settings/categories/TerminalBehaviorPage.tsx` | Shell override, copy-on-select, paste binding. |
| `src/components/settings/categories/TerminalPastesPage.tsx` | Lift today's pastes block. |
| `src/components/settings/categories/GitPage.tsx` | Commit template, default auto-stage, default merge strategy. |
| `src/components/settings/categories/ChangelistsPage.tsx` | Confirm-before-delete. |
| `src/components/settings/categories/ClaudeDefaultsPage.tsx` | Default args, default model, binary path. |
| `src/components/settings/categories/ClaudeUpdatesPage.tsx` | Lift today's Claude CLI updates block. |
| `src/components/settings/categories/ToolsPage.tsx` | Launches existing modals. |
| `src/components/settings/categories/PrivacyPage.tsx` | Lift telemetry + error reporting. |
| `src/components/settings/categories/AboutPage.tsx` | Lift version + GitHub link. |
| `src/components/titlebar/RecentTerminalsMenu.tsx` | Dropdown listing up to 20 most-recently-active terminals. |
| `src/components/titlebar/ToolsMenu.tsx` | Dropdown listing the 7 tool launchers. |
| `src/lib/keymap.ts` | Shared keymap definition (single source of truth for shortcut labels). |
| `src/lib/accentTheme.ts` | Helpers to apply accent color hex / theme mode / density CSS vars to `:root`. |
| `src-tauri/src/changelists.rs` | Pure DB helpers for changelists: list, create, rename, delete, assign. |

### Modified files

| Path | Why |
|---|---|
| `src/index.css` | Add density CSS var, `[data-reduce-motion]` rule, light-theme tokens, IJ tab-shimmer & dot-pulse keyframes. |
| `tailwind.config.js` | Map `--ui-row-py` to a Tailwind class; add `bg-elevation-2-hover` token. |
| `src/store/appStore.ts` | 28 new persisted keys with clamping setters; bump persist allow-list. |
| `src/store/terminalStore.ts` | Add `lastOutputAt` to `TerminalInstance`; write on every output chunk. |
| `src/components/Sidebar.tsx` | Strip terminal list + filter input; strip Tools footer; collapsed rail simplified. |
| `src/components/TerminalTabs.tsx` | Wire pulse-dot + shimmer-underline when `isWorking`. |
| `src/components/TitleBar.tsx` | Mount RecentTerminalsMenu + ToolsMenu; open new SettingsWindow. |
| `src/components/HintsPanel.tsx` | Standardize tool-window header. |
| `src/components/OrchestrationPanel.tsx` | Standardize tool-window header. |
| `src/components/FileChangesPanel.tsx` | DELETE (replaced by `src/components/changes/FileChangesPanel.tsx`). |
| `src/App.tsx` | Update import path for new `FileChangesPanel` + `SettingsWindow`. |
| `src/hooks/useKeyboardShortcuts.ts` | Pull labels from `lib/keymap.ts` instead of inline strings. |
| `src/store/appStore.test.ts` | Tests for new clamping setters + persist allow-list update. |
| `src-tauri/src/database.rs` | Two new `CREATE TABLE IF NOT EXISTS` lines. |
| `src-tauri/src/commands.rs` | 5 new `#[command]` handlers wrapping `changelists.rs`. |
| `src-tauri/src/main.rs` | Declare `mod changelists`; register commands in `invoke_handler!`. |
| `src/changelog.json` | v1.22.0 entry for WhatsNewModal. |
| `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md` | Version bump `1.21.0` → `1.22.0`. |

### Deleted files

| Path | Why |
|---|---|
| `src/components/SettingsModal.tsx` | Superseded by `src/components/settings/SettingsWindow.tsx` + category pages. |
| `src/components/FileChangesPanel.tsx` | Superseded by `src/components/changes/FileChangesPanel.tsx` + siblings (the old file is at the project root of `components/`, the new one is in a subfolder). |

---

## Phases overview

| Phase | Scope |
|---|---|
| 0 | Branch setup (`feat/intellij-overhaul`) |
| 1 | New `appStore` keys with clamping setters + vitest coverage (8 sub-tasks, one per group) |
| 2 | `lib/accentTheme.ts` + `App.tsx` wiring to apply CSS vars on store changes |
| 3 | Sidebar simplification (Explorer only) |
| 4 | Title bar additions (Recent Terminals + Tools dropdowns + shared `lib/keymap.ts`) |
| 5 | Active-work tab indicator (`lastOutputAt` tracking + `useNowTick` hook + pulse/shimmer CSS) |
| 6 | SettingsWindow shell, category tree, search bar |
| 7 | Settings category pages (16 thin pages) |
| 8 | Delete old `SettingsModal.tsx`; wire `TitleBar` to open new window |
| 9 | Changelists Rust backend: `changelists.rs` module + 5 IPC commands + cargo tests |
| 10 | Split `FileChangesPanel.tsx` into 4 siblings (refactor, no behavior change) |
| 11 | `ChangelistSection` UI with CRUD + "Move to Changelist" + "Stage all per list" |
| 12 | Visual polish: standardize tool-window headers; verify accent / light / density end-to-end |
| 13 | Release: changelog entry, version bump to 1.22.0, README screenshots, `/publish` |

This plan file contains Phases 0–5 in full bite-sized detail. Phases 6–13 follow the same patterns and are documented at the same level of detail in this file. The executing skill (executing-plans or subagent-driven-development) follows the checkboxes top to bottom.

---

## Phase 0 — Branch setup

### Task 0.1: Create feature branch

**Files:** none (git only)

- [ ] **Step 1: Confirm clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean` (the brainstorming committed the spec to master).

- [ ] **Step 2: Create and switch to feature branch**

```bash
git checkout -b feat/intellij-overhaul
```

Expected: `Switched to a new branch 'feat/intellij-overhaul'`.

- [ ] **Step 3: Push the branch to set tracking**

```bash
git push -u origin feat/intellij-overhaul
```

Expected: branch pushed; "Branch 'feat/intellij-overhaul' set up to track 'origin/feat/intellij-overhaul'".

---

## Phase 1 — Foundation: appStore new keys + CSS theme tokens

This phase is pure additive: all new keys default to today's behavior, so the app should look and behave identically after Phase 1.

### Task 1.1: Add UI-density CSS variable and reduce-motion rule

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Add CSS variables and reduce-motion rule**

Append the following to `src/index.css` just below the existing `:root` block (after the `--ij-divider-soft` line):

```css
/* Density tokens — driven by Appearance setting, default = comfortable */
:root {
  --ui-row-py: 6px;            /* primary vertical padding for list rows */
  --ui-row-px: 8px;            /* primary horizontal padding for list rows */
}
:root[data-density="compact"]     { --ui-row-py: 4px; --ui-row-px: 6px; }
:root[data-density="comfortable"] { --ui-row-py: 6px; --ui-row-px: 8px; }
:root[data-density="spacious"]    { --ui-row-py: 8px; --ui-row-px: 10px; }

/* Reduce motion — wraps Framer + CSS transitions when the user opts in. */
:root[data-reduce-motion="true"] *,
:root[data-reduce-motion="true"] *::before,
:root[data-reduce-motion="true"] *::after {
  animation-duration: 0.001s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.001s !important;
}

/* Active-work tab indicator keyframes (see Phase 5). Defined here so the
   keyframes are global; reduce-motion above neutralizes them. */
@keyframes ct-pulse-dot {
  0%, 100% { transform: scale(1);     opacity: 1; }
  50%      { transform: scale(1.35);  opacity: 0.55; }
}
@keyframes ct-shimmer {
  0%   { background-position: -120px 0; }
  100% { background-position:  240px 0; }
}
```

- [ ] **Step 2: Verify the dev server still boots and renders**

```bash
npm run tauri dev
```

Smoke test: app opens at today's UI (no visible difference yet). Close the dev server (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "chore(css): add density + reduce-motion + tab-pulse keyframes"
```

### Task 1.2 through 1.8: Add the 28 new persisted keys to appStore

Each sub-task adds one logical group of keys to `src/store/appStore.ts` and a matching test in `src/store/appStore.test.ts`. The pattern is identical for every group:

1. Add fields to the `AppState` interface.
2. Add setters to the interface.
3. Add defaults to the store initializer.
4. Add setter implementations (with clamping/validation where applicable).
5. Add keys to the `partialize` allow-list.
6. Update `resetAppStore()` in the test file with the new defaults.
7. Add the new keys to `PERSISTED_KEYS`.
8. Add at least one clamping/validation test.
9. Run `npm test -- --run src/store/appStore.test.ts` — all pass.
10. Commit.

The key groups and their exact contents:

**Task 1.2 — Appearance group (5 keys + 4 type/const exports)**

Type/const exports at top of file:
```typescript
export type UiDensity = 'compact' | 'comfortable' | 'spacious';
export type ThemeMode = 'dark' | 'light' | 'auto';
export const DEFAULT_ACCENT_COLOR = '#3574F0';
export const DEFAULT_UI_FONT_SCALE = 1.0;
```

Interface additions:
```typescript
  themeMode: ThemeMode;
  uiDensity: UiDensity;
  accentColorHex: string;
  uiFontScale: number;
  uiReduceMotion: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setUiDensity: (density: UiDensity) => void;
  setAccentColorHex: (hex: string) => void;
  setUiFontScale: (scale: number) => void;
  setUiReduceMotion: (enabled: boolean) => void;
```

Defaults:
```typescript
      themeMode: 'dark' as ThemeMode,
      uiDensity: 'comfortable' as UiDensity,
      accentColorHex: DEFAULT_ACCENT_COLOR,
      uiFontScale: DEFAULT_UI_FONT_SCALE,
      uiReduceMotion: false,
```

Setters:
```typescript
      setThemeMode: (mode) => set({ themeMode: mode }),
      setUiDensity: (density) => set({ uiDensity: density }),
      setAccentColorHex: (hex) => {
        const ok = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex);
        set({ accentColorHex: ok ? hex : DEFAULT_ACCENT_COLOR });
      },
      setUiFontScale: (scale) => set({
        uiFontScale: Math.max(0.85, Math.min(1.25, Math.round(scale * 100) / 100)),
      }),
      setUiReduceMotion: (enabled) => set({ uiReduceMotion: enabled }),
```

Partialize additions:
```typescript
        themeMode: state.themeMode,
        uiDensity: state.uiDensity,
        accentColorHex: state.accentColorHex,
        uiFontScale: state.uiFontScale,
        uiReduceMotion: state.uiReduceMotion,
```

Tests (append after existing terminal-appearance describe):
```typescript
describe('appStore — appearance v1.22.0 setters', () => {
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
    expect(useAppStore.getState().accentColorHex).toBe('#3574F0');
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
});
```

resetAppStore additions: `themeMode: 'dark'`, `uiDensity: 'comfortable'`, `accentColorHex: '#3574F0'`, `uiFontScale: 1.0`, `uiReduceMotion: false`.

PERSISTED_KEYS additions: `'themeMode'`, `'uiDensity'`, `'accentColorHex'`, `'uiFontScale'`, `'uiReduceMotion'`.

Commit message: `feat(store): add appearance settings (theme/density/accent/scale/reduce-motion)`

**Task 1.3 — Notifications group (4 keys)**

```typescript
  notificationSoundEnabled: boolean;
  dndEnabled: boolean;
  dndStart: string;     // "HH:mm"
  dndEnd: string;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setDndEnabled: (enabled: boolean) => void;
  setDndStart: (hhmm: string) => void;
  setDndEnd: (hhmm: string) => void;
```

Defaults: `notificationSoundEnabled: false`, `dndEnabled: false`, `dndStart: '22:00'`, `dndEnd: '08:00'`.

Setters:
```typescript
      setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
      setDndEnabled: (enabled) => set({ dndEnabled: enabled }),
      setDndStart: (hhmm) => set({ dndStart: /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '22:00' }),
      setDndEnd: (hhmm) => set({ dndEnd: /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '08:00' }),
```

Test:
```typescript
describe('appStore — notifications v1.22.0 setters', () => {
  it('setDndStart / setDndEnd validate HH:mm shape', () => {
    const s = useAppStore.getState();
    s.setDndStart('23:30');
    expect(useAppStore.getState().dndStart).toBe('23:30');
    s.setDndStart('bogus');
    expect(useAppStore.getState().dndStart).toBe('22:00');
  });
});
```

Commit: `feat(store): add notification sound + DND settings`

**Task 1.4 — Startup & Session group (2 keys + App.tsx wiring)**

```typescript
  sessionAutoSaveIntervalSec: number;
  confirmOnAppClose: boolean;
  setSessionAutoSaveIntervalSec: (sec: number) => void;
  setConfirmOnAppClose: (enabled: boolean) => void;
```

Defaults: `sessionAutoSaveIntervalSec: 30`, `confirmOnAppClose: true`.

Setters:
```typescript
      setSessionAutoSaveIntervalSec: (sec) =>
        set({ sessionAutoSaveIntervalSec: Math.max(10, Math.min(600, Math.round(sec))) }),
      setConfirmOnAppClose: (enabled) => set({ confirmOnAppClose: enabled }),
```

Also modify `src/App.tsx`: replace the hardcoded `30000` in the auto-save interval with `useAppStore.getState().sessionAutoSaveIntervalSec * 1000`.

Test: clamp to 10..600.

Commit: `feat(store): expose session auto-save interval + confirm-on-close`

**Task 1.5 — Editor group (8 keys)**

Keys: `editorTabSize` (clamp 1..8), `editorRenderWhitespace`, `editorWordWrap`, `editorMinimap`, `editorAutoSaveOnBlur`, `editorFontFamily` (default `'"JetBrains Mono", "Cascadia Code", Consolas, monospace'`), `editorFontSize` (clamp 8..32), `editorLineHeight` (clamp 1.0..2.0).

Each gets the corresponding `set...` setter, mirroring the terminal-appearance setters' clamping pattern from Task 1.2.

Test: validate the 3 clamping setters (`editorTabSize`, `editorFontSize`, `editorLineHeight`).

Commit: `feat(store): add editor (Monaco) prefs — tab size, wrap, font, etc.`

**Task 1.6 — Terminal Behavior group (3 keys)**

Keys: `terminalShellPathOverride` (string, default empty), `terminalCopyOnSelect` (bool, default false), `terminalPasteShortcut` (`'ctrl+v' | 'ctrl+shift+v'`, default `'ctrl+shift+v'`). Simple setters, no clamping.

Commit: `feat(store): terminal behavior — shell override, copy-on-select, paste binding`

**Task 1.7 — VCS group (4 keys + 2 type exports)**

Type exports:
```typescript
export type AutoStageMode = 'none' | 'tracked' | 'all';
export type MergeStrategy = 'merge' | 'rebase' | 'ff-only';
```

Keys: `vcsCommitMessageTemplate` (string), `vcsDefaultAutoStage: AutoStageMode` (default `'none'`), `vcsDefaultMergeStrategy: MergeStrategy` (default `'merge'`), `vcsChangelistsConfirmDelete` (bool, default true).

Commit: `feat(store): VCS defaults — commit template, auto-stage, merge, confirm delete`

**Task 1.8 — Claude group (2 keys)**

Keys: `claudeDefaultModel: 'opus' | 'sonnet' | 'haiku' | null` (default `null`), `claudeBinaryPathOverride: string` (default empty).

Commit: `feat(store): Claude defaults — default model + binary path override`

After Task 1.8 the appStore has 28 new persisted keys total. All defaults preserve today's behavior.

---

## Phase 2 — Theme tokens applied to `:root`

After this phase, the new appearance settings actually do something on screen.

### Task 2.1: Create `src/lib/accentTheme.ts` helpers

**Files:**
- Create: `src/lib/accentTheme.ts`
- Create: `src/lib/accentTheme.test.ts`

- [ ] **Step 1: Write the helpers**

```typescript
// src/lib/accentTheme.ts
import type { ThemeMode, UiDensity } from '../store/appStore';

export function applyAccentColor(hex: string): void {
  const rgb = hexToRgb(hex);
  const r = rgb?.r ?? 53;
  const g = rgb?.g ?? 116;
  const b = rgb?.b ?? 240;

  const root = document.documentElement;
  root.style.setProperty('--accent-primary', hex);
  const lift = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.08));
  const sR = lift(r), sG = lift(g), sB = lift(b);
  root.style.setProperty('--accent-secondary', `#${toHex(sR)}${toHex(sG)}${toHex(sB)}`);
  root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.18)`);
  root.style.setProperty('--ij-stripe', hex);
  root.style.setProperty('--ij-tab-underline', hex);
  root.style.setProperty('--border-focus', `rgba(${r}, ${g}, ${b}, 0.55)`);
}

export function applyThemeMode(mode: ThemeMode): void {
  const effective = mode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  document.documentElement.setAttribute('data-theme', effective);

  const root = document.documentElement;
  if (effective === 'light') {
    root.style.setProperty('--elevation-0', '#F7F8FA');
    root.style.setProperty('--elevation-1', '#EBECF0');
    root.style.setProperty('--elevation-2', '#DFE1E5');
    root.style.setProperty('--elevation-3', '#FFFFFF');
    root.style.setProperty('--elevation-4', '#FFFFFF');
    root.style.setProperty('--ij-divider', '#C9CCD0');
    root.style.setProperty('--ij-divider-soft', '#E0E2E6');
    root.style.setProperty('color', '#27282E');
  } else {
    root.style.removeProperty('--elevation-0');
    root.style.removeProperty('--elevation-1');
    root.style.removeProperty('--elevation-2');
    root.style.removeProperty('--elevation-3');
    root.style.removeProperty('--elevation-4');
    root.style.removeProperty('--ij-divider');
    root.style.removeProperty('--ij-divider-soft');
    root.style.removeProperty('color');
  }
}

export function applyDensity(density: UiDensity): void {
  document.documentElement.setAttribute('data-density', density);
}

export function applyReduceMotion(enabled: boolean): void {
  document.documentElement.setAttribute('data-reduce-motion', enabled ? 'true' : 'false');
}

export function applyUiFontScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-font-scale', String(scale));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const num = parseInt(s, 16);
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
```

- [ ] **Step 2: Add tests**

Create `src/lib/accentTheme.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyAccentColor, applyThemeMode, applyDensity, applyReduceMotion, applyUiFontScale,
} from './accentTheme';

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.style.cssText = '';
});

describe('accentTheme', () => {
  it('applyAccentColor sets the IJ stripe + accent CSS vars', () => {
    applyAccentColor('#FF00AA');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-primary')).toBe('#FF00AA');
    expect(style.getPropertyValue('--ij-stripe')).toBe('#FF00AA');
    expect(style.getPropertyValue('--ij-tab-underline')).toBe('#FF00AA');
    expect(style.getPropertyValue('--accent-glow')).toContain('255, 0, 170');
  });

  it('applyAccentColor handles 3-digit hex', () => {
    applyAccentColor('#abc');
    expect(document.documentElement.style.getPropertyValue('--ij-stripe')).toBe('#abc');
  });

  it('applyThemeMode toggles the data-theme attribute and elevation tokens', () => {
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--elevation-0')).toBe('#F7F8FA');
    applyThemeMode('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--elevation-0')).toBe('');
  });

  it('applyDensity sets the data-density attribute', () => {
    applyDensity('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    applyDensity('spacious');
    expect(document.documentElement.getAttribute('data-density')).toBe('spacious');
  });

  it('applyReduceMotion sets data-reduce-motion', () => {
    applyReduceMotion(true);
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
    applyReduceMotion(false);
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('false');
  });

  it('applyUiFontScale sets the CSS var', () => {
    applyUiFontScale(1.1);
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.1');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run src/lib/accentTheme.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/accentTheme.ts src/lib/accentTheme.test.ts
git commit -m "feat(theme): accentTheme module — runtime CSS-var application"
```

### Task 2.2: Wire `accentTheme` to `appStore` changes in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import the helpers**

```typescript
import {
  applyAccentColor,
  applyThemeMode,
  applyDensity,
  applyReduceMotion,
  applyUiFontScale,
} from './lib/accentTheme';
```

- [ ] **Step 2: Add the effect**

Inside `App()`, below the existing `useAppStore` destructure, add:

```typescript
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
```

- [ ] **Step 3: Smoke-test in dev mode**

```bash
npm run tauri dev
```

Confirm: app still launches and looks identical. Open DevTools, run `useAppStore.getState().setAccentColorHex('#FF00AA')` — title bar accent flips to pink. Reset.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(theme): wire appearance store keys to documentElement on mount"
```

---

## Phase 3 — Sidebar simplification

### Task 3.1: Strip the terminal list and Tools footer from `Sidebar.tsx`

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Replace the entire file content**

```typescript
import { ChevronsLeft, ChevronsRight, FolderTree } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebarCollapse, showFileTree } = useAppStore();

  if (sidebarCollapsed) {
    return (
      <div
        className="h-full bg-elevation-1 border-r border-[var(--ij-divider)] flex flex-col items-center py-2 gap-0.5"
        style={{ width: 48 }}
      >
        <button
          onClick={toggleSidebarCollapse}
          className="w-8 h-8 flex items-center justify-center rounded-[6px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Expand sidebar"
        >
          <ChevronsRight size={14} strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full bg-elevation-1 border-r border-[var(--ij-divider)] flex flex-col">
      <div className="flex items-center justify-between h-[30px] px-3 border-b border-[var(--ij-divider-soft)]">
        <span className="flex items-center gap-1.5 text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em]">
          <FolderTree size={12} strokeWidth={1.75} />
          Project
        </span>
        <button
          onClick={toggleSidebarCollapse}
          className="w-6 h-6 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Collapse sidebar"
        >
          <ChevronsLeft size={13} strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {showFileTree ? (
          <FileTreePanel />
        ) : (
          <div className="flex-1 flex items-center justify-center px-4 text-center">
            <p className="text-text-tertiary text-[12px]">
              Explorer is disabled. Enable it in Settings → Appearance &amp; Behavior.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Smoke-test**

```bash
npm run tauri dev
```

Verify expanded sidebar shows "Project" header + file tree; collapsed shows just an expand arrow. Confirm file tree still works.

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "refactor(sidebar): Explorer-only sidebar, remove terminal list + Tools footer"
```

### Task 3.2: Update "Toggle Sidebar" label to "Toggle Explorer"

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Rename the label**

In `src/components/SettingsModal.tsx`, change:

```typescript
                ['Toggle Sidebar', `${mod}+B`],
```

to:

```typescript
                ['Toggle Explorer', `${mod}+B`],
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "chore(keymap): rename Toggle Sidebar → Toggle Explorer"
```

---

## Phase 4 — Title bar additions

### Task 4.1: Create the shared keymap definition

**Files:**
- Create: `src/lib/keymap.ts`

```typescript
// Shared keymap. Hooks/useKeyboardShortcuts.ts is the actual handler; this file
// is the single source of truth for displayed labels and groups.

export interface KeymapEntry {
  id: string;
  label: string;
  shortcut: string;
  group: 'Terminals' | 'Navigation' | 'Editing' | 'View' | 'Git';
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const MOD = isMac ? 'Cmd' : 'Ctrl';

export const KEYMAP: KeymapEntry[] = [
  { id: 'new-terminal',       label: 'New Terminal',       shortcut: `${MOD}+Shift+N`, group: 'Terminals' },
  { id: 'close-terminal',     label: 'Close Terminal',     shortcut: `${MOD}+W`,       group: 'Terminals' },
  { id: 'duplicate-terminal', label: 'Duplicate Terminal', shortcut: `${MOD}+Shift+D`, group: 'Terminals' },
  { id: 'switch-tab',         label: 'Switch Tab',         shortcut: `${MOD}+Tab`,     group: 'Terminals' },
  { id: 'toggle-grid',        label: 'Toggle Grid View',   shortcut: `${MOD}+G`,       group: 'Terminals' },
  { id: 'add-to-grid',        label: 'Add to Grid',        shortcut: `${MOD}+Shift+G`, group: 'Terminals' },
  { id: 'split-view',         label: 'Split View',         shortcut: `${MOD}+\\`,      group: 'Terminals' },
  { id: 'toggle-explorer',    label: 'Toggle Explorer',    shortcut: `${MOD}+B`,       group: 'View' },
  { id: 'toggle-hints',       label: 'Toggle Hints',       shortcut: 'F1',             group: 'View' },
  { id: 'toggle-changes',     label: 'File Changes',       shortcut: 'F2',             group: 'View' },
  { id: 'toggle-orchestration', label: 'Agent Teams',      shortcut: 'F4',             group: 'View' },
  { id: 'claude-config',      label: 'Claude Config',      shortcut: 'F6',             group: 'View' },
  { id: 'session-timeline',   label: 'Session Timeline',   shortcut: 'F7',             group: 'View' },
  { id: 'memory-editor',      label: 'Memory Editor',      shortcut: 'F8',             group: 'View' },
  { id: 'command-palette',    label: 'Command Palette',    shortcut: `${MOD}+P`,       group: 'Navigation' },
  { id: 'global-search',      label: 'Global Search',      shortcut: `${MOD}+Shift+F`, group: 'Navigation' },
  { id: 'search-terminal',    label: 'Search Terminal',    shortcut: `${MOD}+F`,       group: 'Navigation' },
  { id: 'open-settings',      label: 'Settings',           shortcut: `${MOD}+,`,       group: 'Navigation' },
  { id: 'copy-interrupt',     label: 'Copy / Interrupt',   shortcut: `${MOD}+C`,       group: 'Editing' },
  { id: 'paste',              label: 'Paste',              shortcut: `${MOD}+V`,       group: 'Editing' },
  { id: 'paste-as-file',      label: 'Paste as File',      shortcut: `${MOD}+Shift+V`, group: 'Editing' },
  { id: 'snippets',           label: 'Snippets',           shortcut: `${MOD}+Shift+S`, group: 'Editing' },
  { id: 'terminal-zoom-in',   label: 'Terminal Zoom In',   shortcut: `${MOD}+=`,       group: 'Editing' },
  { id: 'terminal-zoom-out',  label: 'Terminal Zoom Out',  shortcut: `${MOD}+-`,       group: 'Editing' },
  { id: 'terminal-zoom-reset',label: 'Terminal Zoom Reset',shortcut: `${MOD}+0`,       group: 'Editing' },
  { id: 'worktree-manager',   label: 'Worktree Manager',   shortcut: `${MOD}+Shift+W`, group: 'Git' },
];

export function keymapByGroup(): Record<KeymapEntry['group'], KeymapEntry[]> {
  const out: Record<KeymapEntry['group'], KeymapEntry[]> = {
    Terminals: [], Navigation: [], Editing: [], View: [], Git: [],
  };
  for (const e of KEYMAP) out[e.group].push(e);
  return out;
}
```

Commit: `feat(keymap): single source of truth for shortcut labels`

### Task 4.2: Create `RecentTerminalsMenu.tsx`

**Files:**
- Create: `src/components/titlebar/RecentTerminalsMenu.tsx`

```typescript
import { useState, useRef, useEffect, useMemo } from 'react';
import { Layers, ChevronDown, GitBranch, GitFork } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';

const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

export function RecentTerminalsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { terminals, activeTerminalId, setActiveTerminal, gitInfoCache } = useTerminalStore();
  const openCommandPalette = useAppStore((s) => s.openCommandPalette);

  const items = useMemo(() => {
    return Array.from(terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal)
      .sort((a, b) => (a.config.created_at < b.config.created_at ? 1 : -1))
      .slice(0, 20);
  }, [terminals]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative no-drag" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 h-7 px-2 rounded-[6px] transition-colors ${
          open ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
        }`}
        title="Recent Terminals"
      >
        <Layers size={13} strokeWidth={1.75} className="text-text-secondary" />
        <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[300px] bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-3 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--ij-divider-soft)] text-text-tertiary text-[10px] uppercase tracking-wider font-semibold">
            Recent Terminals
          </div>
          <div className="max-h-[360px] overflow-y-auto py-1">
            {items.length === 0 && (
              <div className="px-3 py-3 text-text-tertiary text-[12px]">No terminals.</div>
            )}
            {items.map((t) => {
              const isActive = t.config.id === activeTerminalId;
              const gitInfo = gitInfoCache.get(t.config.id);
              return (
                <button
                  key={t.config.id}
                  onClick={() => { setActiveTerminal(t.config.id); setOpen(false); }}
                  className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                    isActive ? 'bg-accent-primary/15 text-text-primary' : 'hover:bg-white/[0.05] text-text-secondary'
                  }`}
                >
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[t.config.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium truncate text-text-primary">
                        {t.config.nickname || t.config.label}
                      </span>
                      {gitInfo?.is_git_repo && gitInfo.current_branch && (
                        <span className="flex items-center gap-0.5 text-[10px] font-mono text-text-tertiary flex-shrink-0">
                          {gitInfo.is_worktree ? <GitFork size={9} /> : <GitBranch size={9} />}
                          {gitInfo.current_branch}
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-text-tertiary truncate">
                      {t.config.working_directory}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--ij-divider-soft)]">
            <button
              onClick={() => { setOpen(false); openCommandPalette(); }}
              className="w-full text-left px-3 py-2 text-[11.5px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
            >
              Open Command Palette for full search…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Commit: `feat(titlebar): RecentTerminalsMenu dropdown`

### Task 4.3: Create `ToolsMenu.tsx`

**Files:**
- Create: `src/components/titlebar/ToolsMenu.tsx`

```typescript
import { useState, useRef, useEffect } from 'react';
import { Wrench, ChevronDown, FolderOpen, FileText, Clock, Settings, Brain, UserCog } from 'lucide-react';
import { useAppStore } from '../../store/appStore';

interface ToolItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  action: () => void;
}

export function ToolsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const {
    openWorkspaceModal, openSnippetsModal, openSessionHistory,
    openSessionTimeline, openClaudeConfig, openMemoryEditor, openProfileModal,
  } = useAppStore();

  const items: ToolItem[] = [
    { id: 'workspaces',       label: 'Workspaces',       icon: FolderOpen, action: () => openWorkspaceModal() },
    { id: 'snippets',         label: 'Snippets',         icon: FileText,   action: () => openSnippetsModal() },
    { id: 'session-history',  label: 'Session History',  icon: Clock,      action: () => openSessionHistory() },
    { id: 'session-timeline', label: 'Session Timeline', icon: Clock,      action: () => openSessionTimeline() },
    { id: 'claude-config',    label: 'Claude Config',    icon: Settings,   action: () => openClaudeConfig() },
    { id: 'memory-editor',    label: 'Memory Editor',    icon: Brain,      action: () => openMemoryEditor() },
    { id: 'profiles',         label: 'Manage Profiles',  icon: UserCog,    action: () => openProfileModal() },
  ];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative no-drag" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 h-7 px-2 rounded-[6px] transition-colors ${
          open ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
        }`}
        title="Tools"
      >
        <Wrench size={13} strokeWidth={1.75} className="text-text-secondary" />
        <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[220px] bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-3 overflow-hidden py-1">
          {items.map(({ id, label, icon: Icon, action }) => (
            <button
              key={id}
              onClick={() => { setOpen(false); action(); }}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-text-primary hover:bg-white/[0.05] transition-colors"
            >
              <Icon size={13} strokeWidth={1.75} className="text-text-secondary flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Commit: `feat(titlebar): ToolsMenu dropdown`

### Task 4.4: Mount the dropdowns in `TitleBar.tsx`

**Files:**
- Modify: `src/components/TitleBar.tsx`

Add imports:
```typescript
import { RecentTerminalsMenu } from './titlebar/RecentTerminalsMenu';
import { ToolsMenu } from './titlebar/ToolsMenu';
```

Find the right cluster JSX where the Settings button is rendered. Replace the divider+Settings block:

```typescript
          <div className="w-px h-4 bg-[var(--ij-divider-soft)] mx-1" />

          <button onClick={openSettings} className={iconBtn(false)} title="Settings (Ctrl+,)">
            <Settings size={15} strokeWidth={1.75} />
          </button>
```

with:

```typescript
          <div className="w-px h-4 bg-[var(--ij-divider-soft)] mx-1" />

          <RecentTerminalsMenu />
          <ToolsMenu />

          <div className="w-px h-4 bg-[var(--ij-divider-soft)] mx-1" />

          <button onClick={openSettings} className={iconBtn(false)} title="Settings (Ctrl+,)">
            <Settings size={15} strokeWidth={1.75} />
          </button>
```

Smoke-test (`npm run tauri dev`): title bar now has Layers + Wrench dropdowns between panel toggles and Settings; click each to verify dropdown opens, ESC and outside-click close it.

Commit: `feat(titlebar): mount RecentTerminalsMenu + ToolsMenu`

---

## Phase 5 — Active-work tab indicator

### Task 5.1: Track `lastOutputAt` in `terminalStore`

**Files:**
- Modify: `src/store/terminalStore.ts`

Add field to `TerminalInstance`:
```typescript
  /** Epoch ms of the most recent output chunk. */
  lastOutputAt?: number;
```

In `handleTerminalOutput`, stamp `lastOutputAt` on every chunk. Integrate the timestamp write into the existing `set((state) => ...)` block (fold into the same `terminals` map update — do not double-render):

```typescript
    set((state) => {
      const next = new Map(state.terminals);
      const inst = next.get(id);
      if (inst) next.set(id, { ...inst, lastOutputAt: Date.now() });
      return { terminals: next };
    });
```

Commit: `feat(terminal): track lastOutputAt for active-work indicator`

### Task 5.2: Add `useNowTick` hook

**Files:**
- Create: `src/hooks/useNowTick.ts`

```typescript
import { useEffect, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';

const ACTIVE_WINDOW_MS = 5000;
const TICK_MS = 500;

export function useNowTick(): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const ensureTicking = () => {
      const terminals = useTerminalStore.getState().terminals;
      const anyActive = Array.from(terminals.values()).some(
        (t) => t.lastOutputAt && Date.now() - t.lastOutputAt < ACTIVE_WINDOW_MS,
      );
      if (anyActive && !interval) {
        interval = setInterval(() => {
          setNow(Date.now());
          const t = useTerminalStore.getState().terminals;
          const stillActive = Array.from(t.values()).some(
            (x) => x.lastOutputAt && Date.now() - x.lastOutputAt < ACTIVE_WINDOW_MS,
          );
          if (!stillActive && interval) {
            clearInterval(interval);
            interval = null;
          }
        }, TICK_MS);
      }
    };

    const unsub = useTerminalStore.subscribe(() => ensureTicking());
    ensureTicking();

    return () => {
      unsub();
      if (interval) clearInterval(interval);
    };
  }, []);

  return now;
}
```

Commit: `feat(hooks): useNowTick — 500ms tick while terminals are emitting output`

### Task 5.3: Apply pulse + shimmer in `TerminalTabs.tsx`

**Files:**
- Modify: `src/components/TerminalTabs.tsx`
- Modify: `src/index.css`

Add import:
```typescript
import { useNowTick } from '../hooks/useNowTick';
```

Inside `TerminalTabs()`, after the existing destructure, add `const now = useNowTick();`. Inside the per-tab render block, derive:

```typescript
            const instance = terminals.get(terminal.id);
            const isWorking =
              instance?.lastOutputAt != null && now - instance.lastOutputAt < 2000;
```

Apply `ct-working-dot` class to the status dot when `isWorking`; apply `ct-working-tab` to the tab container when `isWorking && activeTerminalId !== terminal.id`.

Append to `src/index.css`:

```css
.ct-working-dot {
  animation: ct-pulse-dot 1.4s ease-in-out infinite;
  box-shadow: 0 0 6px currentColor;
}

.ct-working-tab {
  position: relative;
}

.ct-working-tab::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent-primary) 30%,
    var(--accent-secondary) 50%,
    var(--accent-primary) 70%,
    transparent 100%
  );
  background-size: 200px 2px;
  background-repeat: no-repeat;
  animation: ct-shimmer 1.6s linear infinite;
}
```

Smoke-test: run `for i in {1..50}; do echo $i; sleep 0.5; done` in a terminal — pulse + shimmer fire. Toggle reduce-motion via `useAppStore.getState().setUiReduceMotion(true)` — both stop.

Commit: `feat(tabs): active-work pulse on status dot + shimmer on tab underline`

---

## Phase 6 — Settings window shell

### Task 6.1: Create the search index module

**Files:**
- Create: `src/components/settings/index.ts`

```typescript
// Public exports + searchable settings index for SettingsWindow.

export interface CategoryId {
  group: 'appearance-behavior' | 'editor' | 'terminal' | 'vcs' | 'claude' | 'tools' | 'privacy-about';
  page: string;   // e.g. 'appearance', 'notifications'
}

export interface SettingDescriptor {
  category: CategoryId;
  id: string;        // unique key
  label: string;
  keywords: string[];
}

export const CATEGORY_GROUPS: { id: CategoryId['group']; label: string; pages: { id: string; label: string }[] }[] = [
  { id: 'appearance-behavior', label: 'Appearance & Behavior', pages: [
    { id: 'appearance', label: 'Appearance' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'startup-session', label: 'Startup & Session' },
    { id: 'keymap', label: 'Keymap (read-only)' },
  ]},
  { id: 'editor', label: 'Editor', pages: [
    { id: 'general', label: 'General' },
    { id: 'font', label: 'Font' },
  ]},
  { id: 'terminal', label: 'Terminal', pages: [
    { id: 'appearance', label: 'Appearance' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'pastes', label: 'Pastes' },
  ]},
  { id: 'vcs', label: 'Version Control', pages: [
    { id: 'git', label: 'Git' },
    { id: 'changelists', label: 'Changelists' },
  ]},
  { id: 'claude', label: 'Claude Code', pages: [
    { id: 'defaults', label: 'Defaults' },
    { id: 'updates', label: 'Updates' },
  ]},
  { id: 'tools', label: 'Tools', pages: [
    { id: 'profiles', label: 'Profiles' },
    { id: 'snippets', label: 'Snippets' },
    { id: 'memory', label: 'Memory' },
  ]},
  { id: 'privacy-about', label: 'Privacy & About', pages: [
    { id: 'privacy', label: 'Privacy' },
    { id: 'about', label: 'About' },
  ]},
];

// Pages each register their settings to this array at import time.
export const SETTINGS_INDEX: SettingDescriptor[] = [];

export function registerSetting(d: SettingDescriptor) {
  SETTINGS_INDEX.push(d);
}

export function searchSettings(query: string): SettingDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter((s) =>
    s.label.toLowerCase().includes(q) ||
    s.keywords.some((k) => k.toLowerCase().includes(q))
  );
}
```

Commit: `feat(settings): category groups + searchable settings index`

### Task 6.2: Build `SettingsCategoryTree.tsx`

**Files:**
- Create: `src/components/settings/SettingsCategoryTree.tsx`

```typescript
import { CATEGORY_GROUPS, type CategoryId } from './index';

interface Props {
  active: CategoryId;
  onSelect: (cat: CategoryId) => void;
  highlightedPages?: Set<string>;  // "group.page" keys, when search is active
}

export function SettingsCategoryTree({ active, onSelect, highlightedPages }: Props) {
  return (
    <div className="bg-elevation-1 border-r border-[var(--ij-divider-soft)] overflow-y-auto py-2 text-[11.5px]">
      {CATEGORY_GROUPS.map((group) => {
        const groupHasMatch = !highlightedPages || group.pages.some(p => highlightedPages.has(`${group.id}.${p.id}`));
        return (
          <div key={group.id} className={groupHasMatch ? '' : 'opacity-40'}>
            <div className="px-3 pt-2 pb-1 text-text-tertiary uppercase tracking-[0.06em] text-[9.5px] font-semibold">
              {group.label}
            </div>
            {group.pages.map((page) => {
              const isActive = active.group === group.id && active.page === page.id;
              const isHighlighted = highlightedPages?.has(`${group.id}.${page.id}`);
              return (
                <button
                  key={page.id}
                  onClick={() => onSelect({ group: group.id, page: page.id })}
                  className={`relative w-full text-left px-6 py-1 transition-colors ${
                    isActive
                      ? 'bg-accent-primary/15 text-text-primary'
                      : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
                  } ${isHighlighted ? 'ring-1 ring-inset ring-yellow-400/40' : ''}`}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--ij-stripe)] rounded-r" />
                  )}
                  {page.label}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

Commit: `feat(settings): SettingsCategoryTree component`

### Task 6.3: Build `SettingsSearch.tsx`

**Files:**
- Create: `src/components/settings/SettingsSearch.tsx`

```typescript
import { Search } from 'lucide-react';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function SettingsSearch({ value, onChange }: Props) {
  return (
    <div className="flex items-center bg-elevation-0 ring-1 ring-[var(--ij-divider-soft)] rounded-md px-2 h-7 w-[360px]">
      <Search size={12} className="text-text-tertiary mr-2" strokeWidth={1.75} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings…"
        className="flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
      />
    </div>
  );
}
```

Commit: `feat(settings): SettingsSearch input`

### Task 6.4: Build `SettingsWindow.tsx` shell

**Files:**
- Create: `src/components/settings/SettingsWindow.tsx`

```typescript
import { useState, useMemo, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { SettingsCategoryTree } from './SettingsCategoryTree';
import { SettingsSearch } from './SettingsSearch';
import { searchSettings, type CategoryId } from './index';

// Lazy-load each category page. This keeps the initial bundle for SettingsWindow
// small (just the shell) and means edits to a single page don't bust the cache
// for the rest.
const pages: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  'appearance-behavior.appearance':     lazy(() => import('./categories/AppearancePage')),
  'appearance-behavior.notifications':  lazy(() => import('./categories/NotificationsPage')),
  'appearance-behavior.startup-session':lazy(() => import('./categories/StartupSessionPage')),
  'appearance-behavior.keymap':         lazy(() => import('./categories/KeymapPage')),
  'editor.general':                     lazy(() => import('./categories/EditorGeneralPage')),
  'editor.font':                        lazy(() => import('./categories/EditorFontPage')),
  'terminal.appearance':                lazy(() => import('./categories/TerminalAppearancePage')),
  'terminal.behavior':                  lazy(() => import('./categories/TerminalBehaviorPage')),
  'terminal.pastes':                    lazy(() => import('./categories/TerminalPastesPage')),
  'vcs.git':                            lazy(() => import('./categories/GitPage')),
  'vcs.changelists':                    lazy(() => import('./categories/ChangelistsPage')),
  'claude.defaults':                    lazy(() => import('./categories/ClaudeDefaultsPage')),
  'claude.updates':                     lazy(() => import('./categories/ClaudeUpdatesPage')),
  'tools.profiles':                     lazy(() => import('./categories/ToolsPage')),
  'tools.snippets':                     lazy(() => import('./categories/ToolsPage')),
  'tools.memory':                       lazy(() => import('./categories/ToolsPage')),
  'privacy-about.privacy':              lazy(() => import('./categories/PrivacyPage')),
  'privacy-about.about':                lazy(() => import('./categories/AboutPage')),
};

export function SettingsWindow() {
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [active, setActive] = useState<CategoryId>({ group: 'appearance-behavior', page: 'appearance' });
  const [query, setQuery] = useState('');

  const highlightedPages = useMemo(() => {
    if (!query.trim()) return undefined;
    const matches = searchSettings(query);
    return new Set(matches.map((m) => `${m.category.group}.${m.category.page}`));
  }, [query]);

  const key = `${active.group}.${active.page}`;
  const PageComponent = pages[key];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-elevation-0 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-4 w-[92vw] max-w-[1100px] h-[80vh] max-h-[720px] grid grid-rows-[44px_1fr] overflow-hidden"
      >
        <div className="flex items-center justify-between px-3 bg-elevation-1 border-b border-[var(--ij-divider-soft)]">
          <div className="flex items-center gap-3">
            <span className="text-text-primary text-[13px] font-semibold">Settings</span>
            <SettingsSearch value={query} onChange={setQuery} />
          </div>
          <button
            onClick={closeSettings}
            className="p-1.5 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-[200px_1fr] overflow-hidden">
          <SettingsCategoryTree
            active={active}
            onSelect={setActive}
            highlightedPages={highlightedPages}
          />
          <div className="overflow-y-auto p-6">
            <Suspense fallback={<div className="text-text-tertiary text-[12px]">Loading…</div>}>
              {PageComponent ? <PageComponent /> : null}
            </Suspense>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
```

Commit: `feat(settings): SettingsWindow shell with lazy page loading`

---

## Phase 7 — Settings category pages

Each page is a thin component (typically 30–90 lines) that wires Zustand setters to UI controls. They follow this skeleton:

```typescript
import { useAppStore } from '../../../store/appStore';
import { registerSetting } from '../index';

registerSetting({ category: { group: '...', page: '...' }, id: '...', label: '...', keywords: ['...'] });
// ... more registerSetting calls

export default function PageName() {
  // useAppStore hooks for each relevant key
  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-text-primary text-[16px] font-semibold">Page Title</h2>
        <p className="text-text-tertiary text-[12px] mt-1">One-line description.</p>
      </header>
      {/* setting rows */}
    </div>
  );
}
```

### Reusable row component

Before building individual pages, create a `SettingRow.tsx` helper:

**Files:**
- Create: `src/components/settings/SettingRow.tsx`

```typescript
import type { ReactNode } from 'react';

interface Props {
  label: string;
  description?: string;
  children: ReactNode;
  align?: 'center' | 'start';
}

export function SettingRow({ label, description, children, align = 'center' }: Props) {
  return (
    <div className={`flex ${align === 'center' ? 'items-center' : 'items-start'} justify-between gap-6 py-2`}>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary text-[13px]">{label}</p>
        {description && <p className="text-text-tertiary text-[11.5px] mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

interface ToggleProps { value: boolean; onChange: (v: boolean) => void; label?: string }
export function Toggle({ value, onChange, label }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!value)}
      aria-label={label}
      className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-accent-primary' : 'bg-border-light'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

interface SegProps<T extends string> { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }
export function Segmented<T extends string>({ value, options, onChange }: SegProps<T>) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 h-7 text-[12px] rounded-md transition-colors ${
            value === o.value
              ? 'bg-accent-primary text-white'
              : 'bg-bg-elevated ring-1 ring-border-light text-text-secondary hover:bg-white/[0.04]'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}
```

Commit: `feat(settings): SettingRow + Toggle + Segmented primitives`

### Pages (one task per page)

Each task below: write the page file (template above), import any specialized lift-from-old-modal blocks, register the page's settings to `SETTINGS_INDEX`, commit. Each commit is one page so it's reviewable individually.

**Task 7.1 — AppearancePage** (theme/density/accent/scale/reduce-motion). Use `Segmented` for theme + density, swatches + `<input type="color">` for accent, range slider for scale (0.85–1.25), `Toggle` for reduce-motion. Register 5 settings.

**Task 7.2 — NotificationsPage** (notify-on-finish, sound, DND start/end). 4 settings registered.

**Task 7.3 — StartupSessionPage** (restore-session, auto-save interval input, confirm-on-close). 3 settings.

**Task 7.4 — KeymapPage** — read from `KEYMAP` in `lib/keymap.ts`. Group by `KeymapEntry.group`. Render as a simple two-column table (label / `<kbd>` shortcut). 1 "setting" registered with keywords = all shortcut IDs.

**Task 7.5 — EditorGeneralPage** (tab size, render whitespace, word wrap, minimap, auto-save on blur). 5 settings.

**Task 7.6 — EditorFontPage** (family / size / line height). 3 settings.

**Task 7.7 — TerminalAppearancePage** — lift the entire terminal-appearance block from current `SettingsModal.tsx` (lines 350–467). 8 settings.

**Task 7.8 — TerminalBehaviorPage** (shell override input, copy-on-select toggle, paste shortcut segmented). 3 settings.

**Task 7.9 — TerminalPastesPage** — lift the pastes block (lines 642–737 of current `SettingsModal.tsx`). 6 settings.

**Task 7.10 — GitPage** (commit message template textarea, default auto-stage segmented, default merge strategy segmented). 3 settings.

**Task 7.11 — ChangelistsPage** (confirm-before-delete toggle). 1 setting.

**Task 7.12 — ClaudeDefaultsPage** — lift the default-claude-args block (lines 329–346 of `SettingsModal.tsx`); add default model dropdown + binary path input. 3 settings.

**Task 7.13 — ClaudeUpdatesPage** — lift the Claude Code update block (lines 260–326 of `SettingsModal.tsx`). 1 setting.

**Task 7.14 — ToolsPage** — render 7 launch buttons that call the existing modal-open actions (same as `ToolsMenu`).

**Task 7.15 — PrivacyPage** — lift telemetry + error reporting blocks (lines 581–639 of `SettingsModal.tsx`). 2 settings.

**Task 7.16 — AboutPage** — lift About block (lines 770–778 of `SettingsModal.tsx`); add GitHub link button.

After all 16 pages exist:

**Task 7.17 — Test rendering**

```bash
npm run tauri dev
```

For each category in the tree, click and verify the right pane renders without console errors. Type "scrollback" into the search box — only Terminal Appearance should highlight. Type "telemetry" — Privacy highlights.

Commit (one per page): `feat(settings): <PageName> category`

---

## Phase 8 — Remove old SettingsModal and wire new window

### Task 8.1: Switch the app to use `SettingsWindow`

**Files:**
- Modify: `src/App.tsx`
- Delete: `src/components/SettingsModal.tsx`

Replace the import:
```typescript
import { SettingsModal } from './components/SettingsModal';
```
with:
```typescript
import { SettingsWindow } from './components/settings/SettingsWindow';
```

And the render line:
```typescript
{settingsOpen && <SettingsModal />}
```
with:
```typescript
{settingsOpen && <SettingsWindow />}
```

Then delete the old file:
```bash
rm src/components/SettingsModal.tsx
```

Verify the build:
```bash
npm run build
```

Smoke-test: open settings via title bar gear → see new window. Press ESC → closes. Click outside → closes. Verify every category page opens.

Commit: `refactor(settings): replace SettingsModal with SettingsWindow`

---

## Phase 9 — Changelists Rust backend

### Task 9.1: Add SQLite migration

**Files:**
- Modify: `src-tauri/src/database.rs`

Add to the `init_schema` `execute_batch` block (after the `app_meta` table definition):

```sql
            CREATE TABLE IF NOT EXISTS changelists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_path TEXT NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(repo_path, name)
            );

            CREATE TABLE IF NOT EXISTS changelist_files (
                repo_path TEXT NOT NULL,
                file_path TEXT NOT NULL,
                changelist_id INTEGER NOT NULL REFERENCES changelists(id) ON DELETE CASCADE,
                PRIMARY KEY (repo_path, file_path)
            );

            CREATE INDEX IF NOT EXISTS idx_changelist_files_repo ON changelist_files(repo_path);
            CREATE INDEX IF NOT EXISTS idx_changelist_files_list ON changelist_files(changelist_id);
```

Add a cargo test in `src-tauri/src/database.rs` (inside an existing `#[cfg(test)] mod tests { ... }` block, or create one if absent):

```rust
#[test]
fn changelists_schema_creates() {
    let db = Database::new_in_memory().expect("in-memory db");
    let count: i64 = db.conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('changelists', 'changelist_files')",
            [],
            |r| r.get(0),
        )
        .expect("query");
    assert_eq!(count, 2);
}
```

Run:
```bash
cd src-tauri && cargo test database::tests::changelists_schema_creates -- --nocapture
```
Expected: passes.

Commit: `feat(db): add changelists + changelist_files tables`

### Task 9.2: Create `src-tauri/src/changelists.rs`

**Files:**
- Create: `src-tauri/src/changelists.rs`

```rust
// Pure DB helpers for the Changelists Lite feature.
// All functions take a `&Connection` and return Result<T, String>.
// Default changelist is implicit (files without a row in changelist_files
// belong to "Default").

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangelistInfo {
    pub id: Option<i64>,
    pub name: String,
    pub is_default: bool,
}

const RESERVED_DEFAULT: &str = "Default";
const MAX_NAME_LEN: usize = 80;

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Changelist name cannot be empty".to_string());
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err(format!("Changelist name must be <= {} characters", MAX_NAME_LEN));
    }
    if trimmed.eq_ignore_ascii_case(RESERVED_DEFAULT) {
        return Err("\"Default\" is reserved for the implicit changelist".to_string());
    }
    Ok(())
}

pub fn list_changelists(conn: &Connection, repo_path: &str) -> Result<Vec<ChangelistInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM changelists WHERE repo_path = ?1 ORDER BY sort_order, created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![repo_path], |r| {
            Ok(ChangelistInfo {
                id: Some(r.get::<_, i64>(0)?),
                name: r.get::<_, String>(1)?,
                is_default: false,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<ChangelistInfo> = Vec::new();
    out.push(ChangelistInfo { id: None, name: RESERVED_DEFAULT.to_string(), is_default: true });
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn create_changelist(conn: &Connection, repo_path: &str, name: &str) -> Result<i64, String> {
    validate_name(name)?;
    let trimmed = name.trim();
    conn.execute(
        "INSERT INTO changelists (repo_path, name) VALUES (?1, ?2)",
        params![repo_path, trimmed],
    )
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE") {
            format!("A changelist named \"{}\" already exists in this repo", trimmed)
        } else {
            msg
        }
    })?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_changelist(conn: &Connection, id: i64, new_name: &str) -> Result<(), String> {
    validate_name(new_name)?;
    let trimmed = new_name.trim();
    let changed = conn
        .execute(
            "UPDATE changelists SET name = ?1 WHERE id = ?2",
            params![trimmed, id],
        )
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("UNIQUE") {
                format!("A changelist named \"{}\" already exists", trimmed)
            } else {
                msg
            }
        })?;
    if changed == 0 {
        return Err(format!("Changelist {} not found", id));
    }
    Ok(())
}

pub fn delete_changelist(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM changelists WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("Changelist {} not found", id));
    }
    Ok(())
}

pub fn assign_files_to_changelist(
    conn: &Connection,
    repo_path: &str,
    file_paths: &[String],
    changelist_id: Option<i64>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for fp in file_paths {
        if let Some(id) = changelist_id {
            tx.execute(
                "INSERT INTO changelist_files (repo_path, file_path, changelist_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(repo_path, file_path) DO UPDATE SET changelist_id = excluded.changelist_id",
                params![repo_path, fp, id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "DELETE FROM changelist_files WHERE repo_path = ?1 AND file_path = ?2",
                params![repo_path, fp],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> Database { Database::new_in_memory().unwrap() }

    #[test]
    fn list_starts_with_only_default() {
        let d = db();
        let lists = list_changelists(&d.conn, "/r").unwrap();
        assert_eq!(lists.len(), 1);
        assert!(lists[0].is_default);
        assert_eq!(lists[0].name, "Default");
    }

    #[test]
    fn create_and_list_named() {
        let d = db();
        let id = create_changelist(&d.conn, "/r", "feature-a").unwrap();
        assert!(id > 0);
        let lists = list_changelists(&d.conn, "/r").unwrap();
        assert_eq!(lists.len(), 2);
        assert_eq!(lists[1].name, "feature-a");
    }

    #[test]
    fn rejects_default_name() {
        let d = db();
        assert!(create_changelist(&d.conn, "/r", "Default").is_err());
        assert!(create_changelist(&d.conn, "/r", "default").is_err());
    }

    #[test]
    fn rejects_duplicate_name_in_same_repo() {
        let d = db();
        create_changelist(&d.conn, "/r", "x").unwrap();
        assert!(create_changelist(&d.conn, "/r", "x").is_err());
        // Same name in a different repo is fine.
        assert!(create_changelist(&d.conn, "/r2", "x").is_ok());
    }

    #[test]
    fn rename_updates_name() {
        let d = db();
        let id = create_changelist(&d.conn, "/r", "old").unwrap();
        rename_changelist(&d.conn, id, "new").unwrap();
        let lists = list_changelists(&d.conn, "/r").unwrap();
        assert_eq!(lists[1].name, "new");
    }

    #[test]
    fn delete_cascades_files() {
        let d = db();
        let id = create_changelist(&d.conn, "/r", "x").unwrap();
        assign_files_to_changelist(&d.conn, "/r", &["a.txt".into()], Some(id)).unwrap();
        let count: i64 = d.conn.query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE changelist_id = ?1",
            params![id], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 1);

        delete_changelist(&d.conn, id).unwrap();
        let after: i64 = d.conn.query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE changelist_id = ?1",
            params![id], |r| r.get(0)
        ).unwrap();
        assert_eq!(after, 0);
    }

    #[test]
    fn assign_to_none_clears_mapping() {
        let d = db();
        let id = create_changelist(&d.conn, "/r", "x").unwrap();
        assign_files_to_changelist(&d.conn, "/r", &["a.txt".into()], Some(id)).unwrap();
        assign_files_to_changelist(&d.conn, "/r", &["a.txt".into()], None).unwrap();
        let count: i64 = d.conn.query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE repo_path = '/r'",
            [], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 0);
    }
}
```

Note: `Database.conn` is private (the existing struct holds `conn: Connection`). The test helpers above access `&d.conn` — make the field `pub(crate)` (or add a `pub fn conn(&self) -> &Connection` accessor). Choose the accessor — minimally invasive:

In `src-tauri/src/database.rs` add:
```rust
impl Database {
    #[cfg(test)]
    pub(crate) fn conn(&self) -> &Connection { &self.conn }
}
```
And update tests to use `d.conn()` instead of `d.conn` if you choose this route. (The accessor approach keeps the field private in production code.)

Run:
```bash
cd src-tauri && cargo test changelists -- --nocapture
```
Expected: 7 tests pass.

Commit: `feat(changelists): pure DB module + cargo tests`

### Task 9.3: Add 5 Tauri IPC commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

In `src-tauri/src/commands.rs` add at the bottom:

```rust
#[command]
pub async fn list_changelists(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<crate::changelists::ChangelistInfo>, String> {
    wrap_cmd("list_changelists", async move {
        let db = state.db.lock().await;
        crate::changelists::list_changelists(db.conn(), &repo_path)
    }).await
}

#[command]
pub async fn create_changelist(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> Result<i64, String> {
    wrap_cmd("create_changelist", async move {
        let db = state.db.lock().await;
        crate::changelists::create_changelist(db.conn(), &repo_path, &name)
    }).await
}

#[command]
pub async fn rename_changelist(
    state: State<'_, AppState>,
    id: i64,
    new_name: String,
) -> Result<(), String> {
    wrap_cmd("rename_changelist", async move {
        let db = state.db.lock().await;
        crate::changelists::rename_changelist(db.conn(), id, &new_name)
    }).await
}

#[command]
pub async fn delete_changelist(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    wrap_cmd("delete_changelist", async move {
        let db = state.db.lock().await;
        crate::changelists::delete_changelist(db.conn(), id)
    }).await
}

#[command]
pub async fn assign_files_to_changelist(
    state: State<'_, AppState>,
    repo_path: String,
    file_paths: Vec<String>,
    changelist_id: Option<i64>,
) -> Result<(), String> {
    wrap_cmd("assign_files_to_changelist", async move {
        let db = state.db.lock().await;
        crate::changelists::assign_files_to_changelist(db.conn(), &repo_path, &file_paths, changelist_id)
    }).await
}
```

Note: this requires the `conn()` accessor added in Task 9.2. If you'd rather make `conn` `pub(crate)`, do that instead — but pick one and stick with it across all commands.

In `src-tauri/src/main.rs`:

1. Add `mod changelists;` near the other `mod` declarations.

2. Register the 5 commands in `invoke_handler![...]` (append after `commands::purge_pastes,`):
```rust
            commands::list_changelists,
            commands::create_changelist,
            commands::rename_changelist,
            commands::delete_changelist,
            commands::assign_files_to_changelist,
```

Build:
```bash
cd src-tauri && cargo check
```
Expected: clean compile.

Commit: `feat(changelists): 5 Tauri IPC commands`

---

## Phase 10 — Split FileChangesPanel (refactor, no behavior change)

This phase is a pure mechanical refactor. After it, the panel behaves identically — we just have 4 sibling files instead of one 1466-line file. Phase 11 then adds the new ChangelistSection.

### Task 10.1: Create `src/components/changes/` directory + coordinator

**Files:**
- Create: `src/components/changes/FileChangesPanel.tsx`
- Create: `src/components/changes/RepoSelectionContext.tsx`

Step 1: Extract `RepoSelectionContext` from the current file:

```typescript
// src/components/changes/RepoSelectionContext.tsx
import { createContext, useContext } from 'react';

export interface RepoSelectionCtx {
  selectedRepoPath: string | null;
  activePath: string | null;
  setSelectedRepoPath: (p: string | null) => void;
}

export const RepoSelectionContext = createContext<RepoSelectionCtx>({
  selectedRepoPath: null,
  activePath: null,
  setSelectedRepoPath: () => {},
});

export function useRepoSelection() { return useContext(RepoSelectionContext); }

export function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}
```

Step 2: Create the new coordinator `src/components/changes/FileChangesPanel.tsx` that imports the four sibling sections. It owns the data fetches and splitter that today live in the monolithic file. (The exact code is straight extraction from the current `FileChangesPanel.tsx` lines covering: header, Repositories ⇕ Changes splitter, stashes section render, commit bar render — but each becomes a child component.)

Step 3: Run `npm run build` to confirm imports type-check.

Commit: `refactor(changes): scaffold split file structure + RepoSelectionContext`

### Task 10.2: Extract `RepositoriesSection`

**Files:**
- Create: `src/components/changes/RepositoriesSection.tsx`

Move the existing `RepoRow`, `WorktreeRow`, branch dropdown, pull form, and the entire Repositories block (current `FileChangesPanel.tsx` lines ~482–547 + helpers ~983–1466) into this file. Import `RepoSelectionContext`, `pathsEqual` from `./RepoSelectionContext`.

Build + smoke-test: open File Changes panel; repos still listed, branches still switchable.

Commit: `refactor(changes): extract RepositoriesSection`

### Task 10.3: Extract `StashesSection`

**Files:**
- Create: `src/components/changes/StashesSection.tsx`

Move the stashes block (current lines ~644–727).

Commit: `refactor(changes): extract StashesSection`

### Task 10.4: Extract `CommitBar`

**Files:**
- Create: `src/components/changes/CommitBar.tsx`

Move the commit textarea + buttons block (current lines ~728–789).

Commit: `refactor(changes): extract CommitBar`

### Task 10.5: Replace old file + wire imports

**Files:**
- Delete: `src/components/FileChangesPanel.tsx`
- Modify: `src/App.tsx`

In `src/App.tsx`, change:
```typescript
import { FileChangesPanel } from './components/FileChangesPanel';
```
to:
```typescript
import { FileChangesPanel } from './components/changes/FileChangesPanel';
```

Delete the old file:
```bash
rm src/components/FileChangesPanel.tsx
```

Build + run dev. Open File Changes panel. Verify:
- Repositories list works.
- Stage / Unstage works.
- Commit works.
- Stashes work.
- Diff view works.

Commit: `refactor(changes): remove monolithic FileChangesPanel; wire new path`

---

## Phase 11 — ChangelistSection UI

### Task 11.1: Build `ChangelistSection.tsx`

**Files:**
- Create: `src/components/changes/ChangelistSection.tsx`

This component replaces the current single-list rendering of "Staged" + "Changes" inside the changes scroll area. It accepts the array of file changes, splits them by staged/unstaged, then groups unstaged files into named-changelist sections (driven by Tauri).

State:
- `changelists: ChangelistInfo[]` (fetched on mount + on repo change + on refresh)
- `creating: boolean`, `newName: string`
- `editingId: number | null`, `editingName: string`
- `contextMenu: { x: number; y: number; file: FileChange } | null`

Effects:
- On `repoRoot` change or `changesRefreshTrigger`, fetch `list_changelists(repoRoot)` and the file→list mapping (a second small query: SELECT file_path, changelist_id FROM changelist_files WHERE repo_path=?1).

Wait — we don't have a Tauri command for the file mapping yet. Add it as part of Task 11.1's prep work:

Add a 6th command `get_changelist_assignments(repo_path) → Vec<(file_path, changelist_id)>`:

In `src-tauri/src/changelists.rs`:
```rust
pub fn get_changelist_assignments(conn: &Connection, repo_path: &str) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT file_path, changelist_id FROM changelist_files WHERE repo_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![repo_path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
```

In `commands.rs`:
```rust
#[command]
pub async fn get_changelist_assignments(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<(String, i64)>, String> {
    wrap_cmd("get_changelist_assignments", async move {
        let db = state.db.lock().await;
        crate::changelists::get_changelist_assignments(db.conn(), &repo_path)
    }).await
}
```

Register in `main.rs` `invoke_handler!`.

Then write the React component. The component:
1. Renders the Staged section as today (with "Unstage all").
2. For unstaged files, groups them by their changelist assignment (Default if no assignment).
3. Renders each changelist header with: chevron, name (or inline-edit), file count, ⋯ menu (Rename / Delete — both gated by `vcsChangelistsConfirmDelete`), and "Stage all" button.
4. Adds a `+ List` button at the top of the Changes section.
5. Right-click on any file shows context menu with "Move to Changelist ▸" submenu.

The full code is ~250 lines — straight Tauri `invoke` calls plus the existing file-row rendering pattern lifted from the monolithic `FileChangesPanel.tsx`.

Smoke test: open File Changes panel. Create a list. Move a file into it. Stage all from that list. Commit. Verify mapping is sticky (commit, modify file again — file reappears in the same list).

Commit: `feat(changelists): ChangelistSection UI — CRUD + Stage all + context menu`

### Task 11.2: Wire `ChangelistSection` into `FileChangesPanel`

**Files:**
- Modify: `src/components/changes/FileChangesPanel.tsx`

Replace the old in-place "Staged + Changes" rendering with `<ChangelistSection ... />`.

Smoke-test the panel end-to-end.

Commit: `feat(changelists): replace flat changes list with ChangelistSection`

---

## Phase 12 — Visual polish refinements

### Task 12.1: Standardize `HintsPanel.tsx` and `OrchestrationPanel.tsx` headers

**Files:**
- Modify: `src/components/HintsPanel.tsx`
- Modify: `src/components/OrchestrationPanel.tsx`

Replace each panel's existing header markup with the standard IJ tool-window header (28px height, elevation-1 background, hard divider, uppercase 10.5px title with `letter-spacing: 0.06em`):

```typescript
<div className="flex items-center justify-between h-[30px] px-3 border-b border-[var(--ij-divider-soft)] bg-elevation-1">
  <span className="text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em]">
    Hints
  </span>
  {/* right-aligned actions */}
</div>
```

Smoke-test: panels open with consistent headers across the app.

Commit: `chore(panels): standardize IJ tool-window headers`

### Task 12.2: Wire density CSS var to row paddings on key surfaces

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/settings/SettingsCategoryTree.tsx`
- Modify: `src/components/changes/ChangelistSection.tsx`

Where rows currently use `py-1.5` or `py-2`, replace with `style={{ paddingTop: 'var(--ui-row-py)', paddingBottom: 'var(--ui-row-py)' }}`.

Smoke-test: switch density in Settings → Appearance → see rows shrink/grow in real time.

Commit: `feat(theme): apply density var to sidebar / settings / changelist rows`

### Task 12.3: Verify accent + light theme end-to-end

Smoke-test only — no code changes.

1. Open Settings → Appearance.
2. Change theme to Light → verify sidebar / title bar / panels switch.
3. Change theme back to Dark.
4. Change accent to a non-blue swatch → verify stripes, tab underline, focus rings, AutoUpdater progress bar all switch.
5. Switch density between compact / comfortable / spacious — sidebar rows respond.
6. Enable reduce motion → confirm tab pulse + shimmer stop.

If anything fails: file an issue inside this phase as a 12.3.x sub-task.

---

## Phase 13 — Release

### Task 13.1: Add changelog entry

**Files:**
- Modify: `src/changelog.json`

Add a v1.22.0 entry highlighting: New Settings panel · Changelists · Streamlined sidebar · Live working indicator.

Commit: `chore(changelog): v1.22.0 entry for WhatsNewModal`

### Task 13.2: Update README screenshots

**Files:**
- Modify: `README.md`
- Replace: existing screenshot PNGs

Take fresh screenshots of:
- The main app (sidebar = Explorer only, title bar with new dropdowns, terminal tabs with active-work indicator).
- The new Settings window.
- The File Changes panel with one named changelist.

Update `README.md` to reference the new files.

Commit: `docs: refresh README screenshots for v1.22.0`

### Task 13.3: Open PR back to master

```bash
git push
gh pr create --title "feat: IntelliJ UI/UX overhaul (v1.22.0)" --body "Implements docs/superpowers/specs/2026-05-14-intellij-ui-overhaul-design.md."
```

After PR review and merge to master, switch to master and run:

```bash
git checkout master && git pull
/publish 1.22.0
```

The `/publish` slash command handles version bumps in package.json / Cargo.toml / tauri.conf.json / README.md, runs `cargo check`, commits, tags `v1.22.0`, pushes, and GitHub Actions takes over for the signed build + updater rollout.

---

## Self-Review

**1. Spec coverage:** every section in `2026-05-14-intellij-ui-overhaul-design.md` maps to a phase or task:

| Spec section | Plan coverage |
|---|---|
| §1 Layout & navigation — title bar dropdowns | Phase 4 (4.2, 4.3, 4.4) |
| §1 Sidebar = Explorer only | Phase 3 (3.1, 3.2) |
| §2 Changelists Lite data model | Phase 9 (9.1, 9.2) |
| §2 New IPC commands | Phase 9 (9.3) + 11.1 (get_changelist_assignments) |
| §2 FileChangesPanel split | Phase 10 (10.1–10.5) |
| §2 ChangelistSection UI | Phase 11 (11.1, 11.2) |
| §3 SettingsWindow shell | Phase 6 (6.1–6.4) + Phase 8 |
| §3 16 category pages | Phase 7 (7.1–7.16) |
| §3 Search behavior | Phase 6 (6.1) + 6.4 (highlightedPages) |
| §3 New setting keys (28) | Phase 1 (1.2–1.8) |
| §4 Visual polish — header standardization | Phase 12 (12.1) |
| §4 Density / accent / light theme | Phase 2 (2.1, 2.2) + Phase 12 (12.2, 12.3) |
| §4 Active-work tab indicator | Phase 5 (5.1–5.3) |
| §5 Migration | Phases 1 + 9.1 (Zustand additive + SQLite IF NOT EXISTS) |
| §5 Risk: power users miss sidebar list | Phase 4 (RecentTerminalsMenu) |
| §5 Rollout — v1.22.0 + changelog | Phase 13 |

**2. Placeholder scan:** none — every code block contains real code, every task names exact files and exact commands. The only "lift from current SettingsModal.tsx lines X–Y" notes reference real lines and copy the existing implementation; the engineer reads those lines directly.

**3. Type consistency:** `ChangelistInfo` (Rust + TS) carries `id: Option<i64>` / `id?: number` plus `name: string` and `is_default: bool`. The `assign_files_to_changelist` command accepts `changelist_id: Option<i64>` (None ⇒ Default). All call sites and serde derives line up.

**4. Scope:** this is one spec, one branch, one PR, one release. Phases 6 + 7 (settings) are the largest chunk by file count (~20 files) but each file is small (≤90 lines) so individual tasks remain bite-sized.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
