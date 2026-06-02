import type { Transition, Variants } from 'framer-motion';

// ─── Spring presets ───

/** Fast snap - toggles, switches, small UI elements */
export const springSnap: Transition = { type: 'spring', stiffness: 500, damping: 30 };

/** Smooth - panels, sidebars, layout changes */
export const springSmooth: Transition = { type: 'spring', stiffness: 300, damping: 25 };

/** Gentle - modals, overlays, command palette */
export const springGentle: Transition = { type: 'spring', stiffness: 200, damping: 20 };

// ─── Modal animation variants ───

export const modalOverlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

export const modalContentVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -8 },
};

export const modalTransition: Transition = {
  duration: 0.15,
  ease: 'easeOut',
};

// ─── Sidebar animation ───

export const slideInLeft: Variants = {
  hidden: { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
};

// ─── Fade animation ───

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

export const fadeTransition: Transition = {
  duration: 0.1,
};
