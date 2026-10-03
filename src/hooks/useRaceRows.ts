import { useTerminalStore, type TerminalInstance } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useAttentionStore } from '../store/attentionStore';
import {
  contenderElapsed, contenderStateFor, contenderUsage, terminalForContender, useRaceStore, type CheckRun,
} from '../store/raceStore';
import { pathKey, type ContenderDiff, type ContenderState, type Race, type RaceContender } from '../lib/races';
import { useNowTick } from './useNowTick';

export interface RaceRow {
  contender: RaceContender;
  terminal: TerminalInstance | undefined;
  state: ContenderState;
  elapsedMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  diff: ContenderDiff | undefined;
  check: CheckRun | undefined;
  /** The prompt is staged in this terminal's editor and not sent yet. */
  waiting: boolean;
}

/** Live per-contender view of a race for the header, sidebar and compare view. */
export function useRaceRows(race: Race | undefined): RaceRow[] {
  const terminals = useTerminalStore((s) => s.terminals);
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  // Re-render on metric updates (cost/tokens).
  useTerminalStore((s) => s.terminalMetrics);
  const items = useAttentionStore((s) => s.items);
  const manualDone = useRaceStore((s) => s.manualDone);
  const seenBusy = useRaceStore((s) => s.seenBusy);
  const checks = useRaceStore((s) => s.checks);
  const diffs = useRaceStore((s) => (race ? s.diffs[race.id] : undefined));
  const drafts = useAppStore((s) => s.promptDrafts);
  const now = useNowTick();
  if (!race) return [];
  return race.contenders.map((c, i) => {
    const terminal = terminalForContender(c, terminals);
    const state = contenderStateFor(c, terminals, terminalStates, items, manualDone, seenBusy);
    const usage = contenderUsage(c, terminal?.config.id);
    const id = terminal?.config.id;
    return {
      contender: c,
      terminal,
      state,
      elapsedMs: contenderElapsed(c, now),
      costUsd: usage.costUsd ?? c.stats?.costUsd ?? null,
      tokens: usage.tokens ?? c.stats?.tokens ?? null,
      diff: diffs?.[i],
      check: checks[pathKey(c.worktreePath)],
      waiting: !!id && drafts[id] === race.prompt && (state === 'starting' || state === 'needs-input'),
    };
  });
}

