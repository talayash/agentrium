// Runtime CSS-variable manipulation for theme / density / accent / reduce-motion / font scale.
// All callers go through these helpers - components never write to documentElement.style directly.

import type { ThemeMode, UiDensity, TabHeight } from '../store/appStore';

/** Pixel heights for each user-selectable tab-strip size. Mirrors IntelliJ's
 *  Small/Medium/Large editor tab options. Medium (28px) is the default;
 *  24px "Small" is snugger for laptops, 32px "Large" more clickable. */
export const TAB_HEIGHT_PX: Record<TabHeight, number> = {
  small: 24,
  medium: 28,
  large: 32,
};

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
  root.style.setProperty('--ij-stripe', hex);
  root.style.setProperty('--ij-tab-underline', hex);
  root.style.setProperty('--border-focus', `rgba(${r}, ${g}, ${b}, 0.55)`);
  // Shadow-glow tokens consumed by Tailwind's shadow-glow-sm / shadow-glow-md.
  // Distinct from --accent-glow (0.18) - different consumers, different alphas.
  root.style.setProperty('--accent-glow-sm', `rgba(${r}, ${g}, ${b}, 0.14)`);
  root.style.setProperty('--accent-glow-md', `rgba(${r}, ${g}, ${b}, 0.22)`);
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
    // Flip the text tokens to dark-on-light. Without this the tokens stay at
    // their near-white dark-theme channels and become invisible on light
    // surfaces. Values chosen for WCAG AA on the light elevation ramp:
    // primary ~13:1, secondary ~6:1, tertiary ~4.8:1 (all on elevation-0).
    root.style.setProperty('--text-primary', '39 40 46');     // #27282E
    root.style.setProperty('--text-secondary', '92 96 107');  // #5C606B
    root.style.setProperty('--text-tertiary', '107 111 121'); // #6B6F79
    // Semantic overrides - ExpUI Green4/Yellow4/Red4 (vivid on light bg).
    // Dark defaults live in index.css :root.
    root.style.setProperty('--success', '#208A3C');
    root.style.setProperty('--warning', '#FFAF0F');
    root.style.setProperty('--error',   '#DB3B4B');
  } else {
    root.style.removeProperty('--elevation-0');
    root.style.removeProperty('--elevation-1');
    root.style.removeProperty('--elevation-2');
    root.style.removeProperty('--elevation-3');
    root.style.removeProperty('--elevation-4');
    root.style.removeProperty('--ij-divider');
    root.style.removeProperty('--ij-divider-soft');
    root.style.removeProperty('color');
    // Revert to the dark channel triplets defined in index.css :root.
    root.style.removeProperty('--text-primary');
    root.style.removeProperty('--text-secondary');
    root.style.removeProperty('--text-tertiary');
    // Fall back to :root defaults for semantic colors.
    root.style.removeProperty('--success');
    root.style.removeProperty('--warning');
    root.style.removeProperty('--error');
  }
}

export function applyDensity(density: UiDensity): void {
  document.documentElement.setAttribute('data-density', density);
}

/**
 * Override the --h-tab CSS var based on the user's Tab Height setting.
 * TerminalTabs consumes it via h-[var(--h-tab)] so tabs resize instantly.
 */
export function applyTabHeight(h: TabHeight): void {
  document.documentElement.style.setProperty('--h-tab', `${TAB_HEIGHT_PX[h]}px`);
}

export function applyReduceMotion(enabled: boolean): void {
  document.documentElement.setAttribute('data-reduce-motion', enabled ? 'true' : 'false');
}

export function applyUiFontScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-font-scale', String(scale));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const num = parseInt(s, 16);
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
