import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import appIconUrl from '../assets/app-icon.png';
import { useAppStore } from '../store/appStore';
import { AGENT_SPECS } from '../lib/agents';
import { BrandIcon } from './BrandIcon';
import { SPRING_DEFAULT, SPRING_DRAWER } from '../lib/motionTokens';

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.06 } },
};
const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: SPRING_DEFAULT },
};
const hero: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.82 },
  show: { opacity: 1, y: 0, scale: 1, transition: SPRING_DRAWER },
};

/**
 * The home screen shown when no terminal/file is open. Logo + title +
 * description, then ONE decision: which agent to start. Each card opens the
 * New Session modal with that agent preselected. Staggered spring entrance,
 * slow drifting gradient orbs behind the content; reduced-motion is
 * neutralised by the global cascade + the orbs' own media guard.
 */
export function WelcomeScreen() {
  const openNewTerminalModal = useAppStore((s) => s.openNewTerminalModal);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-text-secondary p-8 overflow-hidden">
      {/* Drifting gradient orbs (ambient depth) */}
      <div aria-hidden className="ct-orb ct-orb-a" />
      <div aria-hidden className="ct-orb ct-orb-b" />

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="relative w-full max-w-[640px] flex flex-col items-center"
      >
        <motion.img
          variants={hero}
          src={appIconUrl}
          alt=""
          className="w-20 h-20 mb-5 select-none drop-shadow-[0_12px_40px_var(--accent-glow-md)]"
          draggable={false}
        />
        <motion.h1 variants={rise} className="text-[40px] font-bold text-text-primary mb-3 tracking-display leading-[1.08]">
          Welcome to Agentrium
        </motion.h1>
        <motion.p variants={rise} className="text-[15px] leading-relaxed text-text-secondary mb-10 text-center max-w-[460px]">
          Run Claude Code, Codex, Cursor, and Antigravity agents side by side
          in one native window. Pick an agent below to get started.
        </motion.p>

        {/* One decision: which agent. Each card opens New Session with that
            agent preselected. */}
        <motion.div variants={rise} className="w-full">
          <div className="text-center text-text-tertiary text-[11px] font-semibold uppercase tracking-[0.14em] mb-3">
            Start a session
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full">
            {AGENT_SPECS.map((spec) => (
              <button
                key={spec.kind}
                onClick={() => openNewTerminalModal(spec.kind)}
                className="group relative isolate overflow-hidden flex flex-col items-center gap-3 py-5 px-3 material-thin rounded-2xl shadow-elevation-2 hover:shadow-elevation-3 hover:-translate-y-1 active:translate-y-0 active:scale-[0.98] transition-[transform,box-shadow] duration-200 ease-out"
              >
                <span aria-hidden className="absolute inset-0 -z-10 rounded-2xl bg-[var(--seam)] opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
                <span className="w-12 h-12 rounded-[14px] bg-elevation-2 ring-1 ring-seam shadow-elevation-2 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
                  <BrandIcon kind={spec.kind} size={26} />
                </span>
                <span className="text-[13px] font-semibold text-text-primary text-center leading-tight">
                  {spec.displayName}
                </span>
              </button>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
