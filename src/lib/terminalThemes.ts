import type { ITheme } from '@xterm/xterm';

export type TerminalThemeName = 'dark' | 'light';

// Dark palette is the existing hardcoded set from TerminalView. Light keeps the
// same accent hues so dark/light feel like one app in two modes, not two
// unrelated terminals — bg flips to near-white, fg flips to near-black, and the
// ANSI accents stay recognisable while being slightly desaturated where needed
// for legibility on a light background.
export const TERMINAL_THEMES: Record<TerminalThemeName, ITheme> = {
  dark: {
    background: '#101010',
    foreground: '#E5E5E5',
    cursor: '#E5E5E5',
    cursorAccent: '#101010',
    selectionBackground: 'rgba(59, 130, 246, 0.25)',
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
    background: '#FAFAFA',
    foreground: '#171717',
    cursor: '#171717',
    cursorAccent: '#FAFAFA',
    selectionBackground: 'rgba(59, 130, 246, 0.20)',
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

export function resolveTerminalTheme(name: string | undefined): ITheme {
  if (name === 'light' || name === 'dark') return TERMINAL_THEMES[name];
  return TERMINAL_THEMES[DEFAULT_TERMINAL_THEME];
}
