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

  it('applyThemeMode("light") sets semantic color overrides (success/warning/error)', () => {
    applyThemeMode('light');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--success')).toBe('#208A3C');
    expect(style.getPropertyValue('--warning')).toBe('#FFAF0F');
    expect(style.getPropertyValue('--error')).toBe('#DB3B4B');
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
    expect(style.getPropertyValue('--success')).toBe('#208A3C');
    expect(style.getPropertyValue('--warning')).toBe('#FFAF0F');
    expect(style.getPropertyValue('--error')).toBe('#DB3B4B');
  });
});
