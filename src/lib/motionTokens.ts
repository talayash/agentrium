// Shared Framer Motion timings + variants. Mirrors the CSS motion tokens in
// index.css so JS-driven and CSS-driven animation feel identical. Reduce-motion
// is handled globally by the :root[data-reduce-motion] cascade, so these
// variants don't need per-call guards.

/** Standard IntelliJ-style easing (matches --ease-out). */
export const EASE_OUT = [0.25, 0.1, 0.25, 1] as const;

/** Durations in seconds (Framer uses seconds; CSS vars use ms). */
export const DUR = { fast: 0.12, base: 0.16, slow: 0.22 } as const;

/** Backdrop / scrim fade. */
export const overlayMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: DUR.fast, ease: EASE_OUT },
};

/** Centered dialog: fade + subtle scale. */
export const dialogMotion = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
  transition: { duration: DUR.base, ease: EASE_OUT },
};

/** Edge drawer slide-in. `offset` is the off-screen X distance in px. */
export const drawerMotion = (offset = 420) => ({
  initial: { x: offset },
  animate: { x: 0 },
  exit: { x: offset },
  transition: { type: 'tween' as const, duration: DUR.slow, ease: EASE_OUT },
});
