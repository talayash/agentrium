import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Flag, Trophy } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import { formatRelativeTime } from '../lib/relativeTime';
import { formatCost, formatElapsed, samePath, winRates, type Race } from '../lib/races';
import { BrandIcon } from './BrandIcon';

function RaceHistoryRow({ race }: { race: Race }) {
  const openRaceTab = useAppStore((s) => s.openRaceTab);
  const winner = race.winnerTask ? race.contenders.find((c) => samePath(c.worktreePath, race.winnerTask!)) : undefined;
  const s = winner?.stats;
  const when = race.decidedAt ?? race.createdAt;
  const age = Date.now() - Date.parse(when);
  return (
    <li>
      <button type="button" onClick={() => openRaceTab(race.id, race.title)}
        className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-fill-hover flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12px] text-text-primary truncate">{race.title}</span>
          <span className="ml-auto text-[10.5px] text-text-tertiary flex-shrink-0">
            {Number.isNaN(age) ? '' : formatRelativeTime(age)}
          </span>
        </span>
        {winner ? (
          <span className="flex items-center gap-1.5 text-[11px] text-text-secondary min-w-0">
            <Trophy size={11} className="text-warning flex-shrink-0" />
            <BrandIcon kind={winner.agent} size={11} />
            <span className="truncate">{winner.label}</span>
            <span className="ml-auto flex-shrink-0 tabular-nums text-text-tertiary">
              {formatElapsed(s?.elapsedMs)} · {formatCost(s?.costUsd)} · {s?.filesChanged ?? 0}f{' '}
              <span className="text-success">+{s?.added ?? 0}</span> <span className="text-error">-{s?.removed ?? 0}</span>
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-text-tertiary">
            {race.status === 'abandoned' ? 'Abandoned' : 'No winner'} · {race.contenders.length} contenders
          </span>
        )}
      </button>
    </li>
  );
}

/** Past races and the local win rate per agent/model. Local only. */
export function RaceHistory() {
  const races = useRaceStore((s) => s.races);
  const [open, setOpen] = useState(true);
  const past = useMemo(
    () => Object.values(races)
      .filter((r) => r.status === 'decided' || r.status === 'abandoned')
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)),
    [races],
  );
  const rates = useMemo(() => winRates(past), [past]);
  if (past.length === 0) return null;
  return (
    <section className="border-b border-seam px-1.5 py-1.5 max-h-[45%] overflow-y-auto flex-shrink-0" aria-label="Races">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-1.5 h-6 text-[11px] uppercase tracking-wide font-semibold text-text-tertiary hover:text-text-secondary">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Flag size={11} /> Races
        <span className="normal-case tracking-normal font-normal">{past.length}</span>
      </button>
      {open && (
        <>
          {rates.length > 0 && (
            <div className="px-2.5 py-1 flex flex-wrap gap-1.5" aria-label="Win rate per agent and model">
              {rates.slice(0, 6).map((r) => (
                <span key={r.key} className="text-[10.5px] px-1.5 h-[18px] flex items-center rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-text-secondary tabular-nums"
                  title={`${r.label}: won ${r.wins} of ${r.races} decided race(s)`}>
                  {r.label} {Math.round(r.rate * 100)}%
                </span>
              ))}
            </div>
          )}
          <ul>{past.map((r) => <RaceHistoryRow key={r.id} race={r} />)}</ul>
        </>
      )}
    </section>
  );
}
