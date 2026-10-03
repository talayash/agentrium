import { useState } from 'react';
import { CheckCircle2, Flag, GitCompareArrows, RotateCcw, Send, Square, Trophy, Undo2, XCircle } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { useRaceStore } from '../store/raceStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { confirmAction } from '../lib/confirmDialog';
import { focusTerminal, reopenFromUi, sendToAllWaiting } from '../lib/raceActions';
import {
  CONTENDER_STATE_LABEL, formatCost, formatElapsed, pathKey, type ContenderState, type Race,
} from '../lib/races';
import { useRaceRows, type RaceRow } from '../hooks/useRaceRows';
import { BrandIcon } from './BrandIcon';
import { Tooltip } from './ui/Tooltip';

const STATE_DOT: Record<ContenderState, string> = {
  starting: 'bg-text-tertiary',
  working: 'bg-accent-primary animate-pulse',
  'needs-input': 'bg-warning',
  done: 'bg-success',
  exited: 'bg-text-secondary',
  error: 'bg-error',
};

export function ContenderStateDot({ state }: { state: ContenderState }) {
  return <span aria-hidden className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATE_DOT[state]}`} />;
}

/** Race header: per-contender state, time, cost and diff size, plus the
 *  race actions. Shown above the contender grid and in the compare view. */
export function RaceHeader({ race, inCompare = false }: { race: Race; inCompare?: boolean }) {
  const rows = useRaceRows(race);
  const setManualDone = useRaceStore((s) => s.setManualDone);
  const manualDone = useRaceStore((s) => s.manualDone);
  const openRaceTab = useAppStore((s) => s.openRaceTab);
  const openDecideRace = useAppStore((s) => s.openDecideRace);
  const [sending, setSending] = useState(false);
  const open = race.status === 'running' || race.status === 'judging';
  const waitingCount = rows.filter((r) => r.waiting).length;

  const stop = async (r: RaceRow) => {
    if (!r.terminal) return;
    const ok = await confirmAction(`Stop ${r.contender.label}? Its session closes; the worktree and its changes stay for comparing.`, { okLabel: 'Stop' });
    if (!ok) return;
    try {
      await useTerminalStore.getState().closeTerminal(r.terminal.config.id);
      setManualDone(r.contender.worktreePath, true);
    } catch (err) {
      toast.error('Stop failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    }
  };

  return (
    <div className="px-3 py-1.5 border-b border-seam bg-elevation-1 flex items-center gap-3 min-w-0" data-race-header>
      <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
        <Flag size={13} className="text-accent-primary flex-shrink-0" strokeWidth={1.9} />
        <span className="text-[12.5px] font-medium text-text-primary max-w-[200px] truncate" title={race.title}>{race.title}</span>
        {!open && (
          <span className="text-[10.5px] px-1.5 h-[16px] flex items-center rounded-md bg-fill-active text-text-secondary capitalize">{race.status}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto scrollbar-none">
        {rows.map((r) => (
          <div key={r.contender.idx} className="group flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-lg ring-1 ring-inset ring-seam bg-elevation-2 flex-shrink-0">
            <Tooltip label={`${r.contender.label}: ${CONTENDER_STATE_LABEL[r.state]}`}>
              <button
                type="button"
                className="flex items-center gap-1.5 text-[11.5px] text-text-primary disabled:cursor-default"
                disabled={!r.terminal}
                onClick={() => r.terminal && focusTerminal(r.terminal.config.id)}
              >
                <ContenderStateDot state={r.state} />
                <BrandIcon kind={r.contender.agent} size={12} />
                <span className="max-w-[140px] truncate">{r.contender.label}</span>
              </button>
            </Tooltip>
            <span className="text-[10.5px] text-text-tertiary tabular-nums">{formatElapsed(r.elapsedMs)}</span>
            {r.costUsd != null && <span className="text-[10.5px] text-emerald-400 tabular-nums">{formatCost(r.costUsd)}</span>}
            {r.diff && (
              <span className="text-[10.5px] tabular-nums text-text-tertiary">
                {r.diff.files.length}f <span className="text-success">+{r.diff.added}</span> <span className="text-error">-{r.diff.removed}</span>
              </span>
            )}
            {open && (
              <span className="flex items-center opacity-60 group-hover:opacity-100 focus-within:opacity-100">
                {manualDone[pathKey(r.contender.worktreePath)] ? (
                  <Tooltip label="Mark not done">
                    <button type="button" aria-label={`Mark ${r.contender.label} not done`}
                      className="p-1 rounded hover:bg-fill-hover text-text-tertiary hover:text-text-primary"
                      onClick={() => setManualDone(r.contender.worktreePath, false)}>
                      <Undo2 size={11} />
                    </button>
                  </Tooltip>
                ) : r.state !== 'done' && (
                  <Tooltip label="Mark done">
                    <button type="button" aria-label={`Mark ${r.contender.label} done`}
                      className="p-1 rounded hover:bg-fill-hover text-text-tertiary hover:text-text-primary"
                      onClick={() => setManualDone(r.contender.worktreePath, true)}>
                      <CheckCircle2 size={11} />
                    </button>
                  </Tooltip>
                )}
                {!r.terminal && (
                  <Tooltip label="Reopen a session in this contender's worktree">
                    <button type="button" aria-label={`Reopen ${r.contender.label}`} onClick={() => void reopenFromUi(race, r.contender)}
                      className="p-1 rounded hover:bg-fill-hover text-text-tertiary hover:text-text-primary">
                      <RotateCcw size={11} />
                    </button>
                  </Tooltip>
                )}
                {r.terminal && r.state !== 'exited' && (
                  <Tooltip label="Stop this contender">
                    <button type="button" aria-label={`Stop ${r.contender.label}`} onClick={() => void stop(r)}
                      className="p-1 rounded hover:bg-fill-hover text-text-tertiary hover:text-error">
                      <Square size={10} />
                    </button>
                  </Tooltip>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1 flex-shrink-0">
        {open && waitingCount > 0 && (
          <button
            type="button"
            disabled={sending}
            onClick={async () => { setSending(true); try { await sendToAllWaiting(race, rows); } finally { setSending(false); } }}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium bg-accent-primary text-white hover:bg-accent-secondary disabled:opacity-50"
          >
            <Send size={12} /> Send to all waiting ({waitingCount})
          </button>
        )}
        {!inCompare && (
          <button type="button" onClick={() => openRaceTab(race.id, race.title)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-fill-hover">
            <GitCompareArrows size={12} /> Compare
          </button>
        )}
        {open && (
          <>
            <button type="button" onClick={() => openDecideRace(race.id, 'decide')}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-text-primary ring-1 ring-inset ring-seam hover:bg-fill-hover">
              <Trophy size={12} /> Pick winner
            </button>
            <Tooltip label="Abandon race: discard every contender">
              <button type="button" aria-label="Abandon race" onClick={() => openDecideRace(race.id, 'abandon')}
                className="flex items-center justify-center h-7 w-7 rounded-lg text-text-tertiary hover:text-error hover:bg-fill-hover">
                <XCircle size={13} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

/** Header above the grid when the grid shows a race's contenders. */
export function RaceGridHeader() {
  const gridTerminalIds = useAppStore((s) => s.gridTerminalIds);
  const terminals = useTerminalStore((s) => s.terminals);
  const races = useRaceStore((s) => s.races);
  const raceId = gridTerminalIds.map((id) => terminals.get(id)?.config.task?.raceId).find(Boolean);
  const race = raceId ? races[raceId] : undefined;
  if (!race) return null;
  return <RaceHeader race={race} />;
}
