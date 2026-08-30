import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import appIcon from '../assets/app-icon.png';

const APP_NAME = 'Agentrium';

// Phase timings (ms). Total ≈ 0.9s prompt + ~0.7s typing + 0.45s hold +
// 0.3s submit + 2.4s logo/loading ≈ 4.7s; click/Enter/Escape skips anytime.
const PROMPT_MS = 900;   // lone blinking underscore before typing starts
const TYPE_MS = 72;      // per typed character
const HOLD_MS = 450;     // full command sits with a blinking caret
const SUBMIT_MS = 300;   // command "executes" and clears
const LOGO_MS = 2400;    // logo + loading bar run

type Phase = 'prompt' | 'typing' | 'hold' | 'submit' | 'logo';

/**
 * Launch splash - a terminal boot vignette: a lone blinking underscore (a
 * console waiting for input), "Agentrium" typed character by character, the
 * command submitted, then the app logo springs in over the gradient loading
 * bar. Shown once per main-window launch; click anywhere to skip. Exit fade
 * is driven by the parent <AnimatePresence>.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('prompt');
  const [typedCount, setTypedCount] = useState(0);
  const [progress, setProgress] = useState(0);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  // Phase sequencer. Timeout-driven state machine rather than one long
  // timeline so a re-render can't drift the caret against the typed text.
  useEffect(() => {
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    at(PROMPT_MS, () => setPhase('typing'));
    for (let i = 1; i <= APP_NAME.length; i++) {
      at(PROMPT_MS + i * TYPE_MS, () => setTypedCount(i));
    }
    const typedDone = PROMPT_MS + APP_NAME.length * TYPE_MS;
    at(typedDone, () => setPhase('hold'));
    at(typedDone + HOLD_MS, () => setPhase('submit'));
    at(typedDone + HOLD_MS + SUBMIT_MS, () => setPhase('logo'));
    at(typedDone + HOLD_MS + SUBMIT_MS + LOGO_MS, finish);

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish(); };
    window.addEventListener('keydown', onKey);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loading-bar progress runs only during the logo phase (the bar enters
  // with the logo, exactly as before).
  useEffect(() => {
    if (phase !== 'logo') return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / LOGO_MS);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const typed = APP_NAME.slice(0, typedCount);
  const showCommandLine = phase === 'prompt' || phase === 'typing' || phase === 'hold' || phase === 'submit';

  return (
    <motion.div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-[#0a0a12] overflow-hidden cursor-pointer"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.55, ease: 'easeInOut' } }}
      onClick={finish}
      role="dialog"
      aria-label="Loading Agentrium"
    >
      {/* Faint night glow that breathes in once the logo lands */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(560px 420px at 50% 42%, rgba(59, 82, 180, 0.28), transparent 70%), radial-gradient(700px 520px at 52% 60%, rgba(122, 91, 255, 0.14), transparent 72%)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === 'logo' ? 1 : 0 }}
        transition={{ duration: 0.9, ease: 'easeOut' }}
      />

      {/* Terminal command line: blinking underscore → typed name → submit */}
      <AnimatePresence>
        {showCommandLine && (
          <motion.div
            key="cmd"
            className="font-mono text-[26px] sm:text-[30px] text-white/90 tracking-[0.02em] select-none"
            initial={{ opacity: 1 }}
            animate={
              phase === 'submit'
                ? { opacity: 0, y: -26, filter: 'blur(6px)' }
                : { opacity: 1, y: 0, filter: 'blur(0px)' }
            }
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: 'easeIn' }}
          >
            <span className="text-[#5b8dff] mr-3 select-none">&gt;</span>
            <span>{typed}</span>
            <span className="ct-caret inline-block w-[0.62em] border-b-[3px] border-white/90 ml-[2px] align-baseline" aria-hidden>
              &nbsp;
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logo entrance + the loading bar (unchanged look) */}
      {phase === 'logo' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.img
            src={appIcon}
            alt=""
            draggable={false}
            className="w-[120px] h-[120px] rounded-[28px] shadow-[0_18px_60px_rgba(59,82,180,0.45)]"
            initial={{ opacity: 0, scale: 0.55, filter: 'blur(14px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            transition={{ type: 'spring', stiffness: 260, damping: 22, mass: 0.9 }}
          />
        </div>
      )}

      {/* Positioning wrapper is a plain div: Framer writes its own inline
          transform, which would overwrite Tailwind's -translate-x-1/2 and
          shove the bar off-center - so the centering transform and the
          entrance animation live on separate elements. */}
      {phase === 'logo' && (
        <div className="absolute bottom-[13%] left-1/2 -translate-x-1/2">
        <motion.div
          className="w-[240px] flex flex-col items-center gap-3.5"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut', delay: 0.15 }}
        >
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
        </motion.div>
        </div>
      )}
    </motion.div>
  );
}
