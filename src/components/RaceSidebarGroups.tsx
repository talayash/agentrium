import { Flag, GitCompareArrows, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import { useTerminalStore } from '../store/terminalStore';
import { CONTENDER_STATE_LABEL, formatCost, formatElapsed, type Race } from '../lib/races';
import { useRaceRows } from '../hooks/useRaceRows';
import { ContenderStateDot } from './RaceHeader';
import { reopenFromUi } from '../lib/raceActions';
import { BrandIcon } from './BrandIcon';

function RaceGroup({ race }: { race: Race }) {
  const rows = useRaceRows(race);
  const openRaceTab = useAppStore((s) => s.openRaceTab);
  const openDecideRace = useAppStore((s) => s.openDecideRace);
  const done = rows.filter((r) => r.state === 'done' || r.state === 'exited' || r.state === 'error').length;
  return (
    <div className="mx-2 mb-2 rounded-xl ring-1 ring-inset ring-seam bg-elevation-1" data-race-group={race.id}>
      <div className="group/race flex items-center rounded-t-xl hover:bg-fill-hover">
        {/* The header opens the race tab (summary, files, diffs, checks). */}
        <button
          type="button"
          onClick={() => openRaceTab(race.id, race.title)}
          aria-label={`Open race ${race.title}`}
          title="Open the race: compare contenders, run checks, pick a winner"
          className="group flex-1 min-w-0 flex items-center gap-1.5 pl-2.5 pr-1 pt-2 pb-1 text-left"
        >
          <Flag size={12} className="text-accent-primary flex-shrink-0" />
          <span className="text-[12px] font-medium text-text-primary truncate group-hover:underline">{race.title}</span>
          <span className="ml-auto text-[10.5px] text-text-tertiary tabular-nums flex-shrink-0">{done}/{rows.length}</span>
          <GitCompareArrows size={12} className="text-text-tertiary group-hover:text-text-primary flex-shrink-0" aria-hidden />
        </button>
        {/* Close, like a tab: abandoning discards the contenders' worktrees
            (with the usual confirmations) and removes the race from here. */}
        <button
          type="button"
          onClick={() => openDecideRace(race.id, 'abandon')}
          aria-label={`Close race ${race.title}`}
          title="Close race: discard every contender (asks first)"
          className="mr-1.5 mt-1 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-active opacity-60 group-hover/race:opacity-100 focus-visible:opacity-100"
        >
          <X size={12} />
        </button>
      </div>
      <ul className="pb-1.5">
        {rows.map((r) => (
          <li key={r.contender.idx}>
            <button
              type="button"
              onClick={() => {
                if (!r.terminal) { void reopenFromUi(race, r.contender); return; }
                useAppStore.getState().setActiveFilePath(null);
                useTerminalStore.getState().setActiveTerminal(r.terminal.config.id);
              }}
              className="w-full flex items-center gap-1.5 px-2.5 h-6 text-left text-[11.5px] text-text-secondary hover:bg-fill-hover hover:text-text-primary"
              title={r.terminal ? `${r.contender.label}: ${CONTENDER_STATE_LABEL[r.state]}` : `${r.contender.label}: no session. Click to reopen one in its worktree.`}
            >
              <ContenderStateDot state={r.state} />
              <BrandIcon kind={r.contender.agent} size={11} />
              <span className="truncate">{r.contender.label}</span>
              <span className="ml-auto flex-shrink-0 tabular-nums text-[10.5px] text-text-tertiary">
                {formatElapsed(r.elapsedMs)}{r.costUsd != null ? ` · ${formatCost(r.costUsd)}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One group per open race at the top of the Sessions navigator. */
export function RaceSidebarGroups() {
  const races = useRaceStore((s) => s.races);
  const open = Object.values(races)
    .filter((r) => r.status === 'running' || r.status === 'judging')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (open.length === 0) return null;
  return (
    <div className="pt-1" aria-label="Races">
      {open.map((r) => <RaceGroup key={r.id} race={r} />)}
    </div>
  );
}
