import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { Plus, Search as SearchIcon, Grid3X3, SlidersHorizontal } from 'lucide-react';
import appIconUrl from '../assets/app-icon.png';
import { useAppStore } from '../store/appStore';
import { SPRING_DEFAULT, SPRING_DRAWER } from '../lib/motionTokens';

const isMac = navigator.platform.toUpperCase().includes('MAC');

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

function Card({ icon, title, desc, onClick, accent = false }: {
  icon: React.ReactNode; title: string; desc: string; onClick: () => void; accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="group relative isolate overflow-hidden flex flex-col items-start gap-3 p-5 material-thin rounded-xl shadow-elevation-2 hover:shadow-elevation-3 hover:-translate-y-1 active:translate-y-0 active:scale-[0.99] transition-[transform,box-shadow] duration-200 ease-out text-left"
    >
      <span aria-hidden className="absolute inset-0 -z-10 rounded-xl bg-[var(--seam)] opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
      <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center transition-colors duration-150 ${
        accent
          ? 'bg-accent-primary/15 text-accent-primary group-hover:bg-accent-primary/25'
          : 'bg-elevation-3 text-text-secondary group-hover:text-accent-primary'
      }`}>
        {icon}
      </div>
      <div>
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        <div className="text-[11.5px] text-text-tertiary mt-0.5">{desc}</div>
      </div>
    </button>
  );
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex items-center justify-between text-text-tertiary">
      <span>{label}</span>
      <span className="flex items-center gap-0.5">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-text-tertiary/60">+</span>}
            <kbd className="px-1 py-0.5 rounded-[4px] bg-elevation-3 ring-1 ring-seam shadow-[0_1px_0_var(--ij-divider)] text-text-secondary font-sans text-[10px]">{k}</kbd>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The home screen shown when no terminal/file is open. Staggered spring
 * entrance, slow drifting gradient orbs behind the content, hover-lift glass
 * cards. Reduced-motion is neutralised by the global cascade + the orbs' own
 * media guard.
 */
export function WelcomeScreen({ onNewTerminal, onToggleGrid, hasTerminals }: {
  onNewTerminal: () => void;
  onToggleGrid: () => void;
  hasTerminals: boolean;
}) {
  const mod = isMac ? '⌘' : 'Ctrl';
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-text-secondary p-8 overflow-hidden">
      {/* Drifting gradient orbs (ambient depth) */}
      <div aria-hidden className="ct-orb ct-orb-a" />
      <div aria-hidden className="ct-orb ct-orb-b" />

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="relative w-full max-w-[560px] flex flex-col items-center"
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
          Run Claude Code, Codex, Cursor, and Antigravity agents side by side in one native window.
          Start a new terminal, or press{' '}
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-elevation-3 ring-1 ring-seam shadow-[0_1px_0_var(--ij-divider)] text-text-secondary text-[11px] font-sans mx-0.5">{mod}</kbd>
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-elevation-3 ring-1 ring-seam shadow-[0_1px_0_var(--ij-divider)] text-text-secondary text-[11px] font-sans mx-0.5">P</kbd>
          {' '}for Search Everywhere.
        </motion.p>

        <motion.div variants={rise} className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mb-6">
          <Card accent icon={<Plus size={18} strokeWidth={2.25} />} title="New Terminal" desc="Start an agent session in any folder" onClick={onNewTerminal} />
          <Card icon={<SearchIcon size={16} strokeWidth={2} />} title="Search Everywhere" desc="Find sessions, actions, hints, and snippets" onClick={() => useAppStore.getState().openCommandPalette()} />
          {hasTerminals && (
            <Card icon={<Grid3X3 size={16} strokeWidth={2} />} title="Grid View" desc="Watch up to 8 sessions side-by-side" onClick={onToggleGrid} />
          )}
          <Card icon={<SlidersHorizontal size={16} strokeWidth={2} />} title="Preferences" desc="Theme, accent, density, keybindings" onClick={() => useAppStore.getState().openSettings()} />
        </motion.div>

        <motion.div variants={rise} className="w-full grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
          <Hint label="Search Everywhere" keys={[mod, 'P']} />
          <Hint label="New Terminal" keys={[mod, isMac ? '⇧' : 'Shift', 'N']} />
          <Hint label="Toggle Sidebar" keys={[mod, 'B']} />
          <Hint label="Toggle Grid" keys={[mod, 'G']} />
        </motion.div>
      </motion.div>
    </div>
  );
}
