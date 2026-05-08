# Terminal Appearance Customization — Design

**Issue:** [#21](https://github.com/talayash/claude-terminal/issues/21)
**Branch:** `21-add-terminal-appearance-customization-font-size-cursor-theme-scrollback-bidi-to-settings`
**Date:** 2026-05-07

## Problem

Terminal rendering options are hardcoded in `TerminalView.tsx` and not exposed in `SettingsModal.tsx`. Three concrete consequences:

1. JetBrains Mono / Fira Code are not preinstalled on Windows → silent fallback to Courier New (generic `monospace`).
2. `scrollback: 100000` × 8 grid terminals can pin ~80 MB of memory on lower-RAM machines, with no user knob.
3. RTL languages (Hebrew, Arabic, Persian) hit cursor-position artifacts because BiDi support is not enabled (`@xterm/addon-unicode11` is not installed).

## Scope

Full proposal from #21 — 7 customizations exposed in a new "Terminal Appearance" section in Settings:

- Font family (combobox with Windows-friendly suggestions)
- Font size (10–24, default 14)
- Line height (1.0–1.6, default 1.2)
- Cursor style (bar / block / underline)
- Cursor blink (on / off)
- Scrollback (1k / 10k / 50k / 100k, default **50k** — reduced from current 100k)
- Theme (dark / light)
- BiDi rendering (off by default)

Plus a **live preview** mini-xterm inside the section so the user can verify font installation and visual choices before committing.

## Architecture

### State (`src/store/appStore.ts`)

Eight new persisted fields and matching setters:

```ts
terminalFontFamily: string;       // default: '"JetBrains Mono", "Cascadia Code", Consolas, monospace'
terminalFontSize: number;         // default 14
terminalLineHeight: number;       // default 1.2
terminalCursorStyle: 'bar'|'block'|'underline';  // default 'bar'
terminalCursorBlink: boolean;     // default true
terminalScrollback: number;       // default 50000
terminalTheme: 'dark'|'light';    // default 'dark'
terminalBidi: boolean;            // default false
```

All eight added to `partialize` so they persist via the existing zustand-persist middleware.

**Default font is a stack** with Windows-friendly fonts first — this silently fixes the Courier New fallback bug for all existing users without requiring them to touch settings.

**Default scrollback drops from 100k to 50k** for new installs and (since the field is new) for all existing users. This is a behavior change but it's the entire motivation of the issue's memory-pressure point.

### Theme registry (`src/lib/terminalThemes.ts`, new)

Decoupled from the store so future themes are a one-file change and the preview can import the same source of truth as the live terminals.

```ts
export type TerminalThemeName = 'dark' | 'light';
export interface TerminalThemeColors { /* xterm ITheme shape */ }
export const TERMINAL_THEMES: Record<TerminalThemeName, TerminalThemeColors> = {
  dark: { /* extracted from current TerminalView.tsx hardcoded colors */ },
  light: { /* inverted background, dark foreground, same accent hues */ },
};
```

The light palette inverts background (`#FAFAFA` ish) and foreground but keeps the same accent hues (`#3B82F6` blue, `#4ADE80` green, etc.) so the two themes feel like one app in two modes, not two unrelated terminals.

### UI section (`src/components/SettingsModal.tsx`)

New "Terminal Appearance" section placed between "Default Claude Arguments" and "Notifications" — groups terminal-feel controls near the top, away from updater/diagnostics at the bottom.

Layout (top to bottom inside the card):
- Live preview (mini xterm, ~120 px tall)
- Font family — `<input list>` + `<datalist>` combobox with curated suggestions
- Font size — numeric stepper (10–24)
- Line height — numeric stepper (1.0–1.6, step 0.1)
- Cursor style — segmented button group (Bar / Block / Underline)
- Cursor blink — toggle switch (matches existing settings style)
- Scrollback — segmented button group (1k / 10k / 50k / 100k)
- Theme — segmented button group (Dark / Light)
- BiDi rendering — toggle switch + 11px hint text explaining when to enable

Matches existing section conventions: `bg-bg-primary rounded-md ring-1 ring-border p-3`, 13 px label / 11 px hint, accent toggles. No new design language introduced.

### Live preview (`src/components/TerminalAppearancePreview.tsx`, new)

A real `Terminal` instance with no PTY, no addons except theme. ~80 lines, single `useEffect` keyed on the eight settings fields. Writes a fixed sample on mount and re-renders on settings change.

Sample content (fixed, non-localized):
```
$ npm run dev
[INFO] vite ready in 921 ms
[ERROR] sample error highlight
The quick brown fox 1234567890 → ←
```

The arrows in the last line make the BiDi toggle's effect visible.

**Why a real xterm and not a styled `<div>`:** the only reliable way to verify "is the typed font installed" is to let xterm render it. A styled div will silently fall back the same way the real terminal does, leaving the user blind to the original bug. With a real-xterm preview, the user sees Courier New the moment they type a wrong font — closing the loop the issue is about.

No WebGL addon (preview is small, DOM renderer is fine and avoids context-loss complexity).

### Live updates (`src/components/TerminalView.tsx`)

A second `useEffect` keyed on the eight settings fields applies changes to the existing `Terminal` instance:

- `fontSize`, `fontFamily`, `lineHeight`, `cursorStyle`, `cursorBlink`, `theme` — set via `terminal.options.X = …`, then `fitAddon.fit()` to reflow.
- `scrollback` and `bidi`/`unicode11` — require `terminal.dispose()` + recreate (xterm caches the scrollback buffer at construction, and the Unicode11 addon attaches once).
- Font family changes are debounced 300 ms so typing into the combobox doesn't recreate the terminal on every keystroke.

### BiDi (`@xterm/addon-unicode11`, new dependency)

When `terminalBidi` is true: `terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';`. The existing `allowProposedApi: true` covers the proposed API requirement. The `bidi` Terminal option mentioned in the issue does not exist as a top-level field in xterm 5.3 — Unicode11 + proposed API is the actual mechanism.

Off by default. Enabling requires terminal recreate (handled in the live-update effect alongside scrollback).

## Data flow

```
User edits control in SettingsModal
  → setTerminalX(value) on appStore
    → zustand persists to localStorage
    → TerminalAppearancePreview's useEffect re-runs → preview xterm reflects change
    → All open TerminalView instances' useEffect re-runs → live apply or recreate
```

Single source of truth: `appStore`. Both the preview and the real terminals subscribe to the same fields via `useAppStore`.

## Error handling

- Unknown font: xterm falls back silently — preview makes this visible.
- Out-of-range numeric input (size, line-height): clamped in the setter, not in the UI.
- BiDi addon import failure: caught in try/catch in `TerminalView`, logged to console, BiDi silently disabled (don't block terminal creation).
- Invalid persisted theme name (e.g. older spec): fall back to `'dark'` in the store hydrator.

## Testing

No automated test framework is wired up in this repo. Verification is manual:

1. `npm run build` — type-check + bundle. Must pass clean.
2. `npm run tauri dev` — open the app.
3. Open Settings → Terminal Appearance.
4. Toggle each control, confirm:
   - Preview updates immediately.
   - Open terminals update immediately for live-settable options.
   - Open terminals reset (clear + reattach) for scrollback / BiDi.
5. Type a non-installed font name — confirm preview falls back visibly.
6. Toggle BiDi, type/paste Hebrew text in a terminal — confirm cursor position is correct.
7. Reload app — confirm settings persist.
8. Switch to light theme — confirm colors are readable and accent hues match.

## Out of scope

- Per-terminal overrides (all terminals share one appearance)
- Custom user-defined themes (registry is hardcoded; future work)
- App-level dark/light theme switcher (terminal-only for this PR)
- Auto-detection of OS theme preference
