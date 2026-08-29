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
  const r = rgb?.r ?? 10;
  const g = rgb?.g ?? 132;
  const b = rgb?.b ?? 255;

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
  root.style.colorScheme = effective; // native scrollbars/controls follow
  if (effective === 'light') {
    // Apple light ramp: soft page gray canvas, white floating surfaces.
    root.style.setProperty('--canvas', '#E4E4E7'); // fallback under reduced-transparency
    root.style.setProperty('--elevation-0', '#FCFCFE'); // content card - near white
    root.style.setProperty('--elevation-1', '#EDEDEF');
    root.style.setProperty('--elevation-2', '#FFFFFF');
    root.style.setProperty('--elevation-3', '#E9E9EB');
    root.style.setProperty('--elevation-4', '#FFFFFF');
    root.style.setProperty('--ij-divider', 'rgba(0, 0, 0, 0.10)');
    root.style.setProperty('--seam', 'rgba(0, 0, 0, 0.08)');
    root.style.setProperty('--seam-strong', 'rgba(0, 0, 0, 0.14)');
    // Dark-on-light interactive fills (the dark defaults vanish on white glass).
    root.style.setProperty('--fill-hover', 'rgba(0, 0, 0, 0.045)');
    root.style.setProperty('--fill-active', 'rgba(0, 0, 0, 0.08)');
    root.style.setProperty('--fill-sel', 'rgba(0, 0, 0, 0.06)');
    root.style.setProperty('--edge-light', 'rgba(255, 255, 255, 0.9)'); // bright light-catch
    // Light-mode materials: white frosted glass over the pastel canvas.
    root.style.setProperty('--material-chrome-bg', 'rgba(255, 255, 255, 0.72)');
    root.style.setProperty('--material-overlay-bg', 'rgba(255, 255, 255, 0.80)');
    root.style.setProperty('--material-sheet-bg', 'rgba(255, 255, 255, 0.97)');
    root.style.setProperty('--material-popover-bg', 'rgba(255, 255, 255, 0.86)');
    root.style.setProperty('--material-thin-bg', 'rgba(255, 255, 255, 0.66)');
    // Soft, cool float shadows over a light canvas.
    root.style.setProperty('--shadow-float-sm', '0 2px 10px rgba(30, 40, 80, 0.08), 0 8px 26px rgba(30, 40, 80, 0.10)');
    root.style.setProperty('--shadow-float-md', '0 4px 14px rgba(30, 40, 80, 0.10), 0 16px 40px rgba(30, 40, 80, 0.12)');
    root.style.setProperty('--shadow-float-lg', '0 10px 34px rgba(30, 40, 80, 0.14), 0 30px 80px rgba(30, 40, 80, 0.18)');
    root.style.setProperty('color', '#1D1D1F');
    // Flip the text tokens to dark-on-light. Without this the tokens stay at
    // their near-white dark-theme channels and become invisible on light
    // surfaces. Apple light labels, WCAG AA-checked on the light ramp:
    // primary ~15:1, secondary ~5.7:1, tertiary ~4.9:1 (all on elevation-0).
    root.style.setProperty('--text-primary', '29 29 31');     // #1D1D1F
    root.style.setProperty('--text-secondary', '99 99 102');  // #636366
    root.style.setProperty('--text-tertiary', '108 108 114'); // #6C6C72
    // Semantic overrides - Apple system palette, text-safe on light.
    // Dark defaults live in index.css :root.
    root.style.setProperty('--success', '#1F8A3D');
    root.style.setProperty('--warning', '#9A5B00');
    root.style.setProperty('--error',   '#D70015');
  } else {
    root.style.removeProperty('--canvas');
    root.style.removeProperty('--elevation-0');
    root.style.removeProperty('--elevation-1');
    root.style.removeProperty('--elevation-2');
    root.style.removeProperty('--elevation-3');
    root.style.removeProperty('--elevation-4');
    root.style.removeProperty('--ij-divider');
    root.style.removeProperty('--seam');
    root.style.removeProperty('--seam-strong');
    root.style.removeProperty('--fill-hover');
    root.style.removeProperty('--fill-active');
    root.style.removeProperty('--fill-sel');
    root.style.removeProperty('--edge-light');
    root.style.removeProperty('--material-chrome-bg');
    root.style.removeProperty('--material-overlay-bg');
    root.style.removeProperty('--material-sheet-bg');
    root.style.removeProperty('--material-popover-bg');
    root.style.removeProperty('--material-thin-bg');
    root.style.removeProperty('--shadow-float-sm');
    root.style.removeProperty('--shadow-float-md');
    root.style.removeProperty('--shadow-float-lg');
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

/**
 * Flag whether OS-level behind-window blur (mica/acrylic) is active.
 * Chrome surfaces (.material-chrome) only turn translucent under
 * data-vibrancy="on" - without the OS blur they'd expose the raw desktop.
 */
export function applyVibrancy(on: boolean): void {
  document.documentElement.setAttribute('data-vibrancy', on ? 'on' : 'off');
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
