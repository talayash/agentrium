import type { ITheme } from '@xterm/xterm';

export type TerminalThemeName = 'dark' | 'light';

// Dark palette is the existing hardcoded set from TerminalView. Light keeps the
// same accent hues so dark/light feel like one app in two modes, not two
// unrelated terminals - bg flips to near-white, fg flips to near-black, and the
// ANSI accents stay recognisable while being slightly desaturated where needed
// for legibility on a light background.
export const TERMINAL_THEMES: Record<TerminalThemeName, ITheme> = {
  dark: {
    // Match the app shell's elevation-0 (#1E1F22) so the terminal canvas reads
    // as the editor surface, not a separate near-black panel. selectionBackground
    // is overridden per the live accent in resolveTerminalTheme().
    background: '#1E1F22',
    foreground: '#E5E5E5',
    cursor: '#E5E5E5',
    cursorAccent: '#1E1F22',
    selectionBackground: 'rgba(53, 116, 240, 0.28)',
    black: '#171717',
    red: '#EF4444',
    green: '#4ADE80',
    yellow: '#FBBF24',
    blue: '#3B82F6',
    magenta: '#A855F7',
    cyan: '#22D3EE',
    white: '#E5E5E5',
    brightBlack: '#525252',
    brightRed: '#F87171',
    brightGreen: '#86EFAC',
    brightYellow: '#FDE047',
    brightBlue: '#60A5FA',
    brightMagenta: '#C084FC',
    brightCyan: '#67E8F9',
    brightWhite: '#FFFFFF',
  },
  light: {
    // Match the light shell's elevation-0 (#F7F8FA) for the same reason.
    background: '#F7F8FA',
    foreground: '#171717',
    cursor: '#171717',
    cursorAccent: '#F7F8FA',
    selectionBackground: 'rgba(53, 116, 240, 0.20)',
    black: '#171717',
    red: '#DC2626',
    green: '#16A34A',
    yellow: '#CA8A04',
    blue: '#2563EB',
    magenta: '#9333EA',
    cyan: '#0891B2',
    white: '#525252',
    brightBlack: '#404040',
    brightRed: '#EF4444',
    brightGreen: '#22C55E',
    brightYellow: '#EAB308',
    brightBlue: '#3B82F6',
    brightMagenta: '#A855F7',
    brightCyan: '#06B6D4',
    brightWhite: '#171717',
  },
};

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'dark';

// Parse a #rgb / #rrggbb accent into channels so the terminal selection can be
// tinted with the user's live accent color. Returns null on malformed input.
function accentRgb(hex: string | undefined): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  const m = hex.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const num = parseInt(s, 16);
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

export function resolveTerminalTheme(name: string | undefined, accentHex?: string): ITheme {
  const base = name === 'light' || name === 'dark'
    ? TERMINAL_THEMES[name]
    : TERMINAL_THEMES[DEFAULT_TERMINAL_THEME];

  // Tint the selection with the user's live accent so the terminal belongs to
  // the same themed system as the chrome. Cursor stays at the foreground color
  // for legibility against arbitrary cell content.
  const rgb = accentRgb(accentHex);
  if (!rgb) return base;
  return { ...base, selectionBackground: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)` };
}
