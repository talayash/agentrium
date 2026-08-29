import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import splashVideo from '../assets/splash.mp4';

const DURATION = 3200; // ms the splash stays before auto-dismissing

/**
 * Launch splash: the Higgsfield logo-reveal video plays full-bleed behind a
 * modern gradient loading bar, then the whole thing cross-fades away. Shown
 * once per main-window launch; click anywhere to skip. Exit fade is driven by
 * the parent <AnimatePresence>.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
      else finish();
    };
    raf = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-[#0a0a12] overflow-hidden cursor-pointer"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.55, ease: 'easeInOut' } }}
      onClick={finish}
      role="dialog"
      aria-label="Loading Agentrium"
    >
      {/* Logo-reveal video, full-bleed */}
      <video
        src={splashVideo}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
      />
      {/* Legibility vignette for the bar */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/20 via-transparent to-black/60" />

      {/* Modern loading bar */}
      <div className="absolute bottom-[13%] left-1/2 -translate-x-1/2 w-[240px] flex flex-col items-center gap-3.5">
        <div className="relative w-full h-[3px] rounded-full bg-white/15 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#38b6ff] via-[#5b8dff] to-[#7a5bff] shadow-[0_0_14px_rgba(122,91,255,0.75)]"
            style={{ width: `${progress * 100}%`, transition: 'width 90ms linear' }}
          />
          {/* moving sheen on the filled portion */}
          <div
            className="absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-white/40 to-transparent"
            style={{ left: `calc(${progress * 100}% - 4rem)`, opacity: progress > 0.02 && progress < 0.99 ? 1 : 0 }}
          />
        </div>
        <div className="text-white/75 text-[11px] font-semibold tracking-[0.22em] uppercase">Agentrium</div>
      </div>
    </motion.div>
  );
}
