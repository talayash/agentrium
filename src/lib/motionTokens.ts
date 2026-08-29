// Shared motion system - Apple fluid-interface springs (Framer Motion).
// Everything that MOVES uses a spring (inherently interruptible + velocity-
// aware); only pure fades use tweens. CSS micro-transitions (hover tints)
// keep the --dur/--ease vars in index.css. Reduce-motion is handled globally
// by the :root[data-reduce-motion] cascade, so these variants don't need
// per-call guards.
//
// Spring vocabulary (Apple: damping ratio + response):
// - damping 1.0 (bounce 0)  = critically damped - graceful settle, no overshoot.
//   The default for all UI.
// - damping ~0.8 (bounce ~0.2) = slight overshoot - ONLY when the gesture
//   carried momentum (a flick, a throw, a drag release).
// - response = how fast the value approaches the target (~seconds); a spring
//   has no fixed duration - settle time emerges.

import type { Transition } from 'framer-motion';

/** Legacy easing (kept for pure opacity fades + CSS parity). */
export const EASE_OUT = [0.25, 0.1, 0.25, 1] as const;

/** Durations in seconds (Framer uses seconds; CSS vars use ms). */
export const DUR = { fast: 0.12, base: 0.18, slow: 0.26 } as const;

/* --- Spring presets ----------------------------------------------------- */

/** Critically damped default - most UI (move / reposition / settle). */
export const SPRING_DEFAULT: Transition = { type: 'spring', bounce: 0, duration: 0.35 };

/** Snappy variant - small elements: popovers, menus, chips. */
export const SPRING_SNAPPY: Transition = { type: 'spring', bounce: 0, duration: 0.25 };

/** Gentle variant - large surfaces repositioning. */
export const SPRING_GENTLE: Transition = { type: 'spring', bounce: 0, duration: 0.45 };

/** Momentum spring - a gesture preceded this (flick/throw/drag release). */
export const SPRING_MOMENTUM: Transition = { type: 'spring', bounce: 0.2, duration: 0.4 };

/** Drawer/sheet spring (Apple: damping 0.8, response 0.3). */
export const SPRING_DRAWER: Transition = { type: 'spring', bounce: 0.15, duration: 0.35 };

/* --- Shared variants (consumed across ~19 components) ------------------- */

/** Backdrop / scrim: pure fade (scrims don't move - they materialize). */
export const overlayMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: DUR.base, ease: EASE_OUT },
};

/** Centered dialog: materialize - scale+rise on a spring, quick fade out
 *  along the same path (spatial consistency: exit mirrors entry). */
export const dialogMotion = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { ...SPRING_DEFAULT, opacity: { duration: DUR.base, ease: EASE_OUT } },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 6,
    transition: { duration: DUR.fast, ease: EASE_OUT },
  },
};

/** Popover / menu: quick pop from its origin. Pair with a transform-origin
 *  anchored to the trigger so it grows out of what opened it. */
export const popMotion = {
  initial: { opacity: 0, scale: 0.95 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { ...SPRING_SNAPPY, opacity: { duration: DUR.fast, ease: EASE_OUT } },
  },
  exit: { opacity: 0, scale: 0.97, transition: { duration: DUR.fast, ease: EASE_OUT } },
};

/** Edge drawer slide-in on a sheet spring. `offset` is the off-screen X
 *  distance in px. Exits along the same path it entered. */
export const drawerMotion = (offset = 420) => ({
  initial: { x: offset },
  animate: { x: 0, transition: SPRING_DRAWER },
  exit: { x: offset, transition: { duration: DUR.slow, ease: EASE_OUT } },
});

/* --- Gesture math (Apple, Designing Fluid Interfaces) ------------------- */

/**
 * Project where a flick would coast to rest (exponential decay - the same
 * curve as scroll deceleration). Pick the snap target nearest the PROJECTED
 * point, not the release point, then spring there handing off `velocity`.
 * @param initialVelocity px/s at release
 * @param decelerationRate 0.998 = normal scroll feel; 0.99 = snappier
 */
export function projectMomentum(initialVelocity: number, decelerationRate = 0.998): number {
  return ((initialVelocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Rubber-band resistance past a boundary: the further past the bound, the
 * less the element follows. Feed it the raw overshoot; render the result.
 * @param overshoot px past the boundary (signed)
 * @param dimension size of the axis being dragged (px)
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Decide commit-vs-cancel for a release: velocity direction wins over
 * position when it's decisive; otherwise fall back to how far we got.
 */
export function shouldCommit(
  offset: number,
  velocity: number,
  distance: number,
  velocityThreshold = 250,
): boolean {
  if (Math.abs(velocity) > velocityThreshold) return velocity > 0;
  return offset > distance / 2;
}
