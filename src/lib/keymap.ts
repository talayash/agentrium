// Shared keymap definitions. Hooks/useKeyboardShortcuts.ts is the actual handler;
// this file is the single source of truth for displayed labels and groups.

// Layout-independent Ctrl+letter matcher. `KeyboardEvent.key` returns the
// character produced by the CURRENT keyboard layout - on a Hebrew (or Cyrillic,
// Arabic, Greek, ...) layout the physical V key produces `e.key === 'ה'`, so
// `key === 'v'` never matches and every Ctrl+letter accelerator (paste, copy,
// close, sidebar, ...) silently breaks. `KeyboardEvent.code` reports the
// physical key's position on a US-QWERTY layout (`'KeyV'`, `'Digit0'`), which
// is stable across layouts and matches how users think about shortcuts (they
// find them by physical position, same as VS Code / browsers).
//
// Use for letters and digits only - non-letter accelerators (Tab, F1..F8, ,,
// =, -, \, +) should keep reading `e.key`, whose semantic identity is layout-
// independent for those keys.
export function matchesKeyCode(e: KeyboardEvent, letterOrDigit: string): boolean {
  const s = letterOrDigit.toUpperCase();
  if (s.length !== 1) return false;
  if (s >= 'A' && s <= 'Z') return e.code === `Key${s}`;
  if (s >= '0' && s <= '9') return e.code === `Digit${s}`;
  return false;
}

export interface KeymapEntry {
  id: string;
  label: string;
  shortcut: string;
  group: 'Terminals' | 'Navigation' | 'Editing' | 'View' | 'Git';
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const MOD = isMac ? 'Cmd' : 'Ctrl';

export const KEYMAP: KeymapEntry[] = [
  { id: 'new-terminal',         label: 'New Terminal',         shortcut: `${MOD}+Shift+N`, group: 'Terminals' },
  { id: 'close-terminal',       label: 'Close Terminal',       shortcut: `${MOD}+W`,       group: 'Terminals' },
  { id: 'duplicate-terminal',   label: 'Duplicate Terminal',   shortcut: `${MOD}+Shift+D`, group: 'Terminals' },
  { id: 'switch-tab',           label: 'Next Tab',             shortcut: `${MOD}+Tab`,       group: 'Terminals' },
  { id: 'prev-tab',             label: 'Previous Tab',         shortcut: `${MOD}+Shift+Tab`, group: 'Terminals' },
  { id: 'toggle-grid',          label: 'Toggle Grid View',     shortcut: `${MOD}+G`,       group: 'Terminals' },
  { id: 'add-to-grid',          label: 'Add to Grid',          shortcut: `${MOD}+Shift+G`, group: 'Terminals' },
  { id: 'split-view',           label: 'Split View',           shortcut: `${MOD}+\\`,      group: 'Terminals' },
  { id: 'toggle-explorer',      label: 'Toggle Explorer',      shortcut: `${MOD}+B`,       group: 'View' },
  { id: 'toggle-hints',         label: 'Toggle Hints',         shortcut: 'F1',             group: 'View' },
  { id: 'toggle-changes',       label: 'Git',                  shortcut: 'F2',             group: 'View' },
  { id: 'toggle-workspaces',    label: 'Workspaces',           shortcut: 'F4',             group: 'View' },
  { id: 'claude-config',        label: 'Claude Config',        shortcut: 'F6',             group: 'View' },
  { id: 'session-timeline',     label: 'Session Timeline',     shortcut: 'F7',             group: 'View' },
  { id: 'memory-editor',        label: 'Memory Editor',        shortcut: 'F8',             group: 'View' },
  { id: 'command-palette',      label: 'Command Palette',      shortcut: `${MOD}+P`,       group: 'Navigation' },
  { id: 'global-search',        label: 'Global Search',        shortcut: `${MOD}+Shift+F`, group: 'Navigation' },
  { id: 'open-settings',        label: 'Settings',             shortcut: `${MOD}+,`,       group: 'Navigation' },
  { id: 'copy-interrupt',       label: 'Copy / Interrupt',     shortcut: `${MOD}+C`,       group: 'Editing' },
  { id: 'paste',                label: 'Paste',                shortcut: `${MOD}+V`,       group: 'Editing' },
  { id: 'paste-as-file',        label: 'Paste as File',        shortcut: `${MOD}+Shift+V`, group: 'Editing' },
  { id: 'snippets',             label: 'Snippets',             shortcut: `${MOD}+Shift+S`, group: 'Editing' },
  { id: 'terminal-zoom-in',     label: 'Terminal Zoom In',     shortcut: `${MOD}+=`,       group: 'Editing' },
  { id: 'terminal-zoom-out',    label: 'Terminal Zoom Out',    shortcut: `${MOD}+-`,       group: 'Editing' },
  { id: 'terminal-zoom-reset',  label: 'Terminal Zoom Reset',  shortcut: `${MOD}+0`,       group: 'Editing' },
  { id: 'worktree-manager',     label: 'Worktree Manager',     shortcut: `${MOD}+Shift+W`, group: 'Git' },
];

export function keymapByGroup(): Record<KeymapEntry['group'], KeymapEntry[]> {
  const out: Record<KeymapEntry['group'], KeymapEntry[]> = {
    Terminals: [], Navigation: [], Editing: [], View: [], Git: [],
  };
  for (const e of KEYMAP) out[e.group].push(e);
  return out;
}
