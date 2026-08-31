// Resolve the app's `themeMode` setting to a concrete appearance.
//
// Deliberately takes the OS preference as an argument rather than reading
// `matchMedia` (or the DOM `data-theme` attribute) itself: callers inside an
// effect can run before the parent effect that rewrites `data-theme`, so a DOM
// read is stale during a theme flip. Passing the value in keeps this pure and
// makes the flip case testable.

export type ThemeMode = 'dark' | 'light' | 'auto';

export function resolveAppTheme(mode: ThemeMode, prefersLight: boolean): 'dark' | 'light' {
  if (mode === 'auto') return prefersLight ? 'light' : 'dark';
  return mode;
}

/** Current OS preference. Split out so `resolveAppTheme` stays pure. */
export function prefersLightScheme(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}
