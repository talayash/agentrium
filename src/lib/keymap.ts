// Shared keymap definitions. Hooks/useKeyboardShortcuts.ts is the actual handler;
// this file is the single source of truth for displayed labels and groups.

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
  { id: 'switch-tab',           label: 'Switch Tab',           shortcut: `${MOD}+Tab`,     group: 'Terminals' },
  { id: 'toggle-grid',          label: 'Toggle Grid View',     shortcut: `${MOD}+G`,       group: 'Terminals' },
  { id: 'add-to-grid',          label: 'Add to Grid',          shortcut: `${MOD}+Shift+G`, group: 'Terminals' },
  { id: 'split-view',           label: 'Split View',           shortcut: `${MOD}+\\`,      group: 'Terminals' },
  { id: 'toggle-explorer',      label: 'Toggle Explorer',      shortcut: `${MOD}+B`,       group: 'View' },
  { id: 'toggle-hints',         label: 'Toggle Hints',         shortcut: 'F1',             group: 'View' },
  { id: 'toggle-changes',       label: 'Git',                  shortcut: 'F2',             group: 'View' },
  { id: 'toggle-orchestration', label: 'Agent Teams',          shortcut: 'F4',             group: 'View' },
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
