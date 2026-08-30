import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Sun, Moon } from 'lucide-react';
// Sun renders inside the knob (light); Moon inside the knob (dark).
import { useAppStore } from '../../store/appStore';
import { Tooltip } from './Tooltip';
import { SPRING_DRAWER } from '../../lib/motionTokens';

/**
 * Sun/Moon theme switch. A colored pill (warm sky in light, indigo night in
 * dark) with a white knob that springs across, carrying the active icon.
 * Flips between explicit light/dark; if the user was on 'auto' it resolves
 * the current appearance first, then flips to the opposite explicit mode.
 */
export function ThemeToggle() {
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);

  const isDark = useMemo(() => {
    if (themeMode === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return themeMode === 'dark';
  }, [themeMode]);

  return (
    <Tooltip label={isDark ? 'Switch to Light' : 'Switch to Dark'}>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
        className={`no-drag relative w-[48px] h-[26px] rounded-full p-[3px] flex items-center ring-1 ring-inset transition-colors duration-300 active:scale-[0.96] ${
          isDark
            ? 'bg-gradient-to-r from-indigo-600/60 to-violet-500/55 ring-seam-strong'
            : 'bg-gradient-to-r from-amber-200 to-sky-300 ring-black/[0.06]'
        }`}
      >
        <motion.span
          animate={{ x: isDark ? 22 : 0 }}
          transition={SPRING_DRAWER}
          className="relative z-10 w-[20px] h-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.9)] flex items-center justify-center"
        >
          {isDark
            ? <Moon size={12} strokeWidth={2} className="text-indigo-500 fill-indigo-500/25" />
            : <Sun size={12} strokeWidth={2.25} className="text-amber-500" />}
        </motion.span>
      </button>
    </Tooltip>
  );
}
