import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyAccentColor, applyThemeMode, applyDensity, applyReduceMotion, applyUiFontScale,
  contrastRatio, selectedCardBackground,
} from './accentTheme';

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.documentElement.removeAttribute('data-reduce-motion');
  document.documentElement.style.cssText = '';
});

describe('accentTheme', () => {
  it('applyAccentColor sets the selection stripe + accent CSS vars', () => {
    // A high-contrast accent, so the stripe needs no contrast adjustment.
    applyAccentColor('#FFD60A');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-primary')).toBe('#FFD60A');
    expect(style.getPropertyValue('--ij-stripe')).toBe('#FFD60A');
  });

  it('applyAccentColor handles 3-digit hex', () => {
    applyAccentColor('#abc');
    expect(document.documentElement.style.getPropertyValue('--ij-stripe')).toBe('#abc');
  });

  it('applyAccentColor derives shadow-glow-sm/md vars from the chosen accent', () => {
    // Default IntelliJ blue.
    applyAccentColor('#3574F0');
    let style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-glow-sm')).toBe('rgba(53, 116, 240, 0.14)');
    expect(style.getPropertyValue('--accent-glow-md')).toBe('rgba(53, 116, 240, 0.22)');

    // A distinct accent - verify the vars actually track the input, not a
    // hardcoded blue.
    applyAccentColor('#22A322');
    style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-glow-sm')).toBe('rgba(34, 163, 34, 0.14)');
    expect(style.getPropertyValue('--accent-glow-md')).toBe('rgba(34, 163, 34, 0.22)');
  });

  it('applyThemeMode toggles the data-theme attribute and elevation tokens', () => {
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--elevation-0')).toBe('#FCFCFE');
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

  it('applyThemeMode("light") sets semantic color overrides (success/warning/error)', () => {
    applyThemeMode('light');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--success')).toBe('#1F8A3D');
    expect(style.getPropertyValue('--warning')).toBe('#9A5B00');
    expect(style.getPropertyValue('--error')).toBe('#D70015');
  });

  it('applyThemeMode("dark") removes semantic color overrides so :root defaults win', () => {
    // Prime the overrides via light mode first.
    applyThemeMode('light');
    applyThemeMode('dark');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--success')).toBe('');
    expect(style.getPropertyValue('--warning')).toBe('');
    expect(style.getPropertyValue('--error')).toBe('');
  });

  it('applyThemeMode restores/removes semantic overrides cleanly across light -> dark -> light', () => {
    applyThemeMode('light');
    applyThemeMode('dark');
    applyThemeMode('light');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--success')).toBe('#1F8A3D');
    expect(style.getPropertyValue('--warning')).toBe('#9A5B00');
    expect(style.getPropertyValue('--error')).toBe('#D70015');
  });
});

describe('selection stripe contrast', () => {
  const stripe = () => document.documentElement.style.getPropertyValue('--ij-stripe');
  const stripeContrast = (accent: string, theme: 'light' | 'dark') =>
    contrastRatio(stripe(), selectedCardBackground(accent, theme));

  it('keeps an accent that already has enough contrast unchanged', () => {
    applyThemeMode('dark');
    applyAccentColor('#FFD60A');
    expect(stripe()).toBe('#FFD60A');
  });

  it('darkens the default blue in light mode to reach 3:1 on the tinted card', () => {
    applyThemeMode('light');
    applyAccentColor('#0A84FF');
    expect(stripe()).not.toBe('#0A84FF');
    expect(stripeContrast('#0A84FF', 'light')).toBeGreaterThanOrEqual(3);
  });

  it('rescues a pale accent in light mode', () => {
    applyThemeMode('light');
    applyAccentColor('#F5E663');
    expect(stripeContrast('#F5E663', 'light')).toBeGreaterThanOrEqual(3);
  });

  it('lightens a very dark accent in dark mode', () => {
    applyThemeMode('dark');
    applyAccentColor('#1A237E');
    expect(stripeContrast('#1A237E', 'dark')).toBeGreaterThanOrEqual(3);
  });

  it('leaves the accent itself untouched', () => {
    applyThemeMode('light');
    applyAccentColor('#F5E663');
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#F5E663');
  });

  it('recomputes the stripe when only the theme changes', () => {
    applyThemeMode('light');
    applyAccentColor('#0A84FF');
    const lightStripe = stripe();
    applyThemeMode('dark');
    expect(stripe()).not.toBe(lightStripe);
    expect(stripeContrast('#0A84FF', 'dark')).toBeGreaterThanOrEqual(3);
  });
});
