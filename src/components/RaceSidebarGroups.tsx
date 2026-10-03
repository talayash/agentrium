import { Flag, GitCompareArrows } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import { useTerminalStore } from '../store/terminalStore';
import { CONTENDER_STATE_LABEL, formatCost, formatElapsed, type Race } from '../lib/races';
import { useRaceRows } from '../hooks/useRaceRows';
import { ContenderStateDot } from './RaceHeader';
import { BrandIcon } from './BrandIcon';
import { Tooltip } from './ui/Tooltip';

function RaceGroup({ race }: { race: Race }) {
  const rows = useRaceRows(race);
  const openRaceTab = useAppStore((s) => s.openRaceTab);
  const done = rows.filter((r) => r.state === 'done' || r.state === 'exited' || r.state === 'error').length;
  return (
    <div className="mx-2 mb-2 rounded-xl ring-1 ring-inset ring-seam bg-elevation-1" data-race-group={race.id}>
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
        <Flag size={12} className="text-accent-primary flex-shrink-0" />
        <span className="text-[12px] font-medium text-text-primary truncate" title={race.title}>{race.title}</span>
        <span className="ml-auto text-[10.5px] text-text-tertiary tabular-nums flex-shrink-0">{done}/{rows.length}</span>
        <Tooltip label="Compare contenders">
          <button type="button" aria-label={`Compare ${race.title}`} onClick={() => openRaceTab(race.id, race.title)}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover">
            <GitCompareArrows size={12} />
          </button>
        </Tooltip>
      </div>
      <ul className="pb-1.5">
        {rows.map((r) => (
          <li key={r.contender.idx}>
            <button
              type="button"
              disabled={!r.terminal}
              onClick={() => {
                if (!r.terminal) return;
                useAppStore.getState().setActiveFilePath(null);
                useTerminalStore.getState().setActiveTerminal(r.terminal.config.id);
              }}
              className="w-full flex items-center gap-1.5 px-2.5 h-6 text-left text-[11.5px] text-text-secondary hover:bg-fill-hover hover:text-text-primary disabled:hover:bg-transparent"
              title={`${r.contender.label}: ${CONTENDER_STATE_LABEL[r.state]}`}
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
