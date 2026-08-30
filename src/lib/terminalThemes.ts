import type { ITheme } from '@xterm/xterm';

/** 'auto' follows the app's light/dark appearance; explicit values pin the
 *  terminal palette regardless of the shell theme. */
export type TerminalThemeName = 'auto' | 'dark' | 'light';

// Dark palette is the existing hardcoded set from TerminalView. Light keeps the
// same accent hues so dark/light feel like one app in two modes, not two
// unrelated terminals - bg flips to near-white, fg flips to near-black, and the
// ANSI accents stay recognisable while being slightly desaturated where needed
// for legibility on a light background.
export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    // Match the app shell's content surface elevation-0 (#0F1320 midnight) so
    // the terminal canvas reads as the editor surface, not a separate panel.
    // selectionBackground is overridden per the live accent in resolveTerminalTheme().
    background: '#0F1320',
    foreground: '#E7E9F0',
    cursor: '#E7E9F0',
    cursorAccent: '#0F1320',
    selectionBackground: 'rgba(10, 132, 255, 0.28)',
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
    // Match the light shell's content surface elevation-0 (#FCFCFE).
    background: '#FCFCFE',
    foreground: '#1D1D1F',
    cursor: '#1D1D1F',
    cursorAccent: '#FCFCFE',
    selectionBackground: 'rgba(0, 122, 255, 0.18)',
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

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'auto';

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

/** The app shell's current effective appearance. applyThemeMode() writes
 *  data-theme on <html> before first paint, so this is always populated. */
function effectiveAppTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function resolveTerminalTheme(
  name: string | undefined,
  accentHex?: string,
  /** Pre-resolved app appearance for 'auto'. Callers reacting to themeMode
   *  changes should pass this explicitly - child effects can run before the
   *  parent effect that rewrites data-theme, so the DOM read may be stale
   *  during a theme flip. */
  appTheme?: 'dark' | 'light',
): ITheme {
  const resolved: 'dark' | 'light' =
    name === 'light' || name === 'dark' ? name : (appTheme ?? effectiveAppTheme());
  const base = TERMINAL_THEMES[resolved];

  // Tint the selection with the user's live accent so the terminal belongs to
  // the same themed system as the chrome. Cursor stays at the foreground color
  // for legibility against arbitrary cell content.
  const rgb = accentRgb(accentHex);
  if (!rgb) return base;
  return { ...base, selectionBackground: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)` };
}
