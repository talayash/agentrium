import { create } from 'zustand';
import {
  allSettled, checkVerdict, deriveContenderState, getRace, getRaceDiffstat, listRaces, pathKey,
  runRaceCheck, cancelRaceCheck, setRaceStatus, updateRaceContender,
  type ContenderDiff, type ContenderState, type ContenderStats, type Race, type RaceCheckResult, type RaceContender,
} from '../lib/races';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useTerminalStore, type TerminalInstance } from './terminalStore';
import { useAttentionStore, type AttentionItem } from './attentionStore';

export interface CheckRun {
  runId: string;
  running: boolean;
  result: RaceCheckResult | null;
  error: string | null;
}

interface RaceStoreState {
  races: Record<string, Race>;
  loaded: boolean;
  /** Worktree keys the user marked done. */
  manualDone: Record<string, true>;
  /** Terminal ids seen busy at least once after the startup grace period. */
  seenBusy: Record<string, true>;
  /** Worktree keys whose terminal was seen in this app session. A contender
   *  without one (app restarted, session not restored) is never recorded as
   *  finished: "exited" there only means "not reopened yet". */
  seenTerminal: Record<string, true>;
  /** Worktree key -> latest check run. */
  checks: Record<string, CheckRun>;
  /** Race id -> diffstat per contender (contender order). */
  diffs: Record<string, ContenderDiff[]>;
  /** Races that already raised "Race ready to compare". */
  readyNotified: Record<string, true>;

  load: () => Promise<void>;
  refresh: (raceId: string) => Promise<Race | null>;
  upsert: (race: Race) => void;
  /** Drop a deleted race from the store. */
  remove: (raceId: string) => void;
  setManualDone: (worktreePath: string, done: boolean) => void;
  markSeenBusy: (terminalId: string) => void;
  markSeenTerminal: (worktreePath: string) => void;
  /** Local finish time of a contender; null when it is working again. */
  setFinishedAt: (raceId: string, worktreePath: string, finishedAt: string | null) => void;
  markReadyNotified: (raceId: string) => void;
  loadDiffs: (raceId: string) => Promise<ContenderDiff[] | null>;
  runChecks: (race: Race, timeoutMin: number) => Promise<void>;
  cancelChecks: (race: Race) => Promise<void>;
}

let runCounter = 0;

export const useRaceStore = create<RaceStoreState>((set, get) => ({
  races: {},
  loaded: false,
  manualDone: {},
  seenBusy: {},
  seenTerminal: {},
  checks: {},
  diffs: {},
  readyNotified: {},

  load: async () => {
    try {
      const list = await listRaces();
      const races: Record<string, Race> = {};
      const readyNotified = { ...get().readyNotified };
      for (const r of list) {
        races[r.id] = r;
        // A race already judged before a restart does not notify again.
        if (r.status !== 'running') readyNotified[r.id] = true;
      }
      set({ races, loaded: true, readyNotified });
    } catch (err) {
      // Startup load: the History and sidebar just show no races.
      reportInvokeFailure('list_races', err);
      set({ loaded: true });
    }
  },

  refresh: async (raceId) => {
    try {
      const race = await getRace(raceId);
      get().upsert(race);
      return race;
    } catch (err) {
      reportInvokeFailure('get_race', err);
      return null;
    }
  },

  upsert: (race) => set((s) => ({ races: { ...s.races, [race.id]: race } })),

  remove: (raceId) => set((s) => {
    const races = { ...s.races };
    const diffs = { ...s.diffs };
    delete races[raceId];
    delete diffs[raceId];
    return { races, diffs };
  }),

  setManualDone: (worktreePath, done) => set((s) => {
    const next = { ...s.manualDone };
    if (done) next[pathKey(worktreePath)] = true;
    else delete next[pathKey(worktreePath)];
    return { manualDone: next };
  }),

  markSeenBusy: (terminalId) => set((s) => (s.seenBusy[terminalId] ? {} : { seenBusy: { ...s.seenBusy, [terminalId]: true } })),

  markSeenTerminal: (worktreePath) => set((s) => {
    const key = pathKey(worktreePath);
    return s.seenTerminal[key] ? {} : { seenTerminal: { ...s.seenTerminal, [key]: true } };
  }),

  setFinishedAt: (raceId, worktreePath, finishedAt) => set((s) => {
    const race = s.races[raceId];
    if (!race) return {};
    const key = pathKey(worktreePath);
    return { races: { ...s.races, [raceId]: {
      ...race,
      contenders: race.contenders.map((c) => (pathKey(c.worktreePath) === key ? { ...c, finishedAt } : c)),
    } } };
  }),

  markReadyNotified: (raceId) => set((s) => ({ readyNotified: { ...s.readyNotified, [raceId]: true } })),

  loadDiffs: async (raceId) => {
    try {
      const diffs = await getRaceDiffstat(raceId);
      set((s) => ({ diffs: { ...s.diffs, [raceId]: diffs } }));
      return diffs;
    } catch (err) {
      reportInvokeFailure('get_race_diffstat', err);
      return null;
    }
  },

  runChecks: async (race, timeoutMin) => {
    const timeoutSecs = Math.max(1, timeoutMin) * 60;
    await Promise.all(race.contenders.map(async (c) => {
      const key = pathKey(c.worktreePath);
      if (get().checks[key]?.running) return;
      runCounter += 1;
      const runId = `${race.id}:${c.idx}:${Date.now()}:${runCounter}`;
      set((s) => ({ checks: { ...s.checks, [key]: { runId, running: true, result: null, error: null } } }));
      try {
        const result = await runRaceCheck(race.id, c.worktreePath, runId, timeoutSecs);
        set((s) => ({ checks: { ...s.checks, [key]: { runId, running: false, result, error: null } } }));
      } catch (err) {
        // Missing worktree / no command: shown in the cell, not a toast storm.
        set((s) => ({ checks: { ...s.checks, [key]: { runId, running: false, result: null, error: String(err) } } }));
        reportInvokeFailure('run_race_check', err);
      }
    }));
  },

  cancelChecks: async (race) => {
    const runs = race.contenders
      .map((c) => get().checks[pathKey(c.worktreePath)])
      .filter((r): r is CheckRun => !!r?.running);
    await Promise.all(runs.map((r) => cancelRaceCheck(r.runId).catch((err) => reportInvokeFailure('cancel_race_check', err))));
  },
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The live terminal working in a contender's worktree, if any. */
export function terminalForContender(
  c: Pick<RaceContender, 'worktreePath'>,
  terminals: Map<string, TerminalInstance>,
): TerminalInstance | undefined {
  const key = pathKey(c.worktreePath);
  for (const t of terminals.values()) {
    if (t.config.task && pathKey(t.config.task.worktreePath) === key) return t;
  }
  return undefined;
}

export function sessionAttentionFor(terminalId: string | undefined, items: AttentionItem[]): AttentionItem['kind'] | null {
  if (!terminalId) return null;
  const item = items.find((i) => i.terminalId === terminalId && i.kind !== 'race' && i.kind !== 'ci' && i.kind !== 'merged');
  return item?.kind ?? null;
}

export function contenderStateFor(
  c: RaceContender,
  terminals: Map<string, TerminalInstance>,
  terminalStates: Map<string, import('../lib/terminalState').SessionState>,
  items: AttentionItem[],
  manualDone: Record<string, true>,
  seenBusy: Record<string, true>,
): ContenderState {
  const t = terminalForContender(c, terminals);
  const id = t?.config.id;
  return deriveContenderState({
    terminalExists: !!t,
    status: t?.config.status,
    inferred: id ? terminalStates.get(id) : undefined,
    attention: sessionAttentionFor(id, items),
    manualDone: !!manualDone[pathKey(c.worktreePath)],
    seenBusy: !!(id && seenBusy[id]),
  });
}

/** Elapsed wall time: start to the latest settle (or now while working). */
export function contenderElapsed(c: RaceContender, now: number): number | null {
  if (!c.startedAt) return null;
  const start = Date.parse(c.startedAt);
  if (Number.isNaN(start)) return null;
  const end = c.finishedAt ? Date.parse(c.finishedAt) : now;
  return Math.max(0, end - start);
}

/** CLI startup (banner, trust and login prompts) renders output too, and a
 *  busy-then-idle blip there must not count as having done the task. Busy
 *  only counts once a terminal has been running this long. */
export const BUSY_GRACE_MS = 10_000;

/** Per-agent usage hook. Claude reports cost and tokens over OTLP; other
 *  agents have no usage source yet. TODO(race): read Codex/Cursor/Antigravity
 *  usage from their session files once a provider exposes it. */
export function contenderUsage(c: RaceContender, terminalId: string | undefined): { costUsd: number | null; tokens: number | null } {
  if (!terminalId) return { costUsd: null, tokens: null };
  const m = useTerminalStore.getState().terminalMetrics.get(terminalId);
  if (!m || c.agent !== 'claude') return { costUsd: null, tokens: null };
  return { costUsd: m.costUsd, tokens: m.tokensInput + m.tokensOutput + m.tokensCacheRead + m.tokensCacheCreation };
}

/** History snapshot of every contender, keyed by worktree path. */
export function statsSnapshot(race: Race, now = Date.now()): Record<string, ContenderStats> {
  const s = useRaceStore.getState();
  const { terminals } = useTerminalStore.getState();
  const diffs = s.diffs[race.id] ?? [];
  const out: Record<string, ContenderStats> = {};
  race.contenders.forEach((c, i) => {
    const t = terminalForContender(c, terminals);
    const usage = contenderUsage(c, t?.config.id);
    const d = diffs[i];
    out[c.worktreePath] = {
      elapsedMs: contenderElapsed(c, now),
      costUsd: usage.costUsd ?? c.stats?.costUsd ?? null,
      tokens: usage.tokens ?? c.stats?.tokens ?? null,
      filesChanged: d?.files.length ?? 0,
      added: d?.added ?? 0,
      removed: d?.removed ?? 0,
      check: checkVerdict(s.checks[pathKey(c.worktreePath)]?.result),
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tracking: settle times and the single "Race ready to compare" item
// ---------------------------------------------------------------------------

/** One pass over every running race. Exported for tests. */
export function trackRaces(now = Date.now()): void {
  const rs = useRaceStore.getState();
  const { terminals, terminalStates } = useTerminalStore.getState();
  const attention = useAttentionStore.getState();
  for (const [id, state] of terminalStates) {
    if (state !== 'busy' || rs.seenBusy[id]) continue;
    const created = Date.parse(terminals.get(id)?.config.created_at ?? '');
    if (!Number.isNaN(created) && now - created >= BUSY_GRACE_MS) rs.markSeenBusy(id);
  }
  for (const race of Object.values(useRaceStore.getState().races)) {
    if (race.status !== 'running') continue;
    for (const c of race.contenders) {
      if (terminalForContender(c, terminals)) rs.markSeenTerminal(c.worktreePath);
    }
  }
  const fresh = useRaceStore.getState();
  for (const race of Object.values(fresh.races)) {
    if (race.status !== 'running') continue;
    const states = race.contenders.map((c) =>
      contenderStateFor(c, terminals, terminalStates, attention.items, fresh.manualDone, fresh.seenBusy));
    const known = race.contenders.map((c) =>
      !!fresh.seenTerminal[pathKey(c.worktreePath)] || !!fresh.manualDone[pathKey(c.worktreePath)]);
    race.contenders.forEach((c, i) => {
      const settled = known[i] && (states[i] === 'done' || states[i] === 'exited' || states[i] === 'error');
      if (settled && !c.finishedAt) {
        const iso = new Date(now).toISOString();
        rs.setFinishedAt(race.id, c.worktreePath, iso);
        updateRaceContender(race.id, c.worktreePath, { finished_at: iso })
          .catch((err) => reportInvokeFailure('update_race_contender', err));
      } else if (c.finishedAt && (states[i] === 'working' || states[i] === 'needs-input')) {
        // Back at work (a follow-up prompt): the clock runs again and the
        // next settle records a new finish time.
        rs.setFinishedAt(race.id, c.worktreePath, null);
      }
    });
    if (known.every(Boolean) && allSettled(states) && !fresh.readyNotified[race.id]) {
      rs.markReadyNotified(race.id);
      const anchor = race.contenders.map((c) => terminalForContender(c, terminals)).find(Boolean);
      if (anchor) {
        attention.put({
          terminalId: anchor.config.id, targetId: anchor.config.id, kind: 'race', raceId: race.id,
          title: race.title, detail: `All ${race.contenders.length} contenders finished. Compare the results and pick a winner.`,
        });
      }
      rs.upsert({ ...race, status: 'judging' });
      setRaceStatus(race.id, 'judging').catch((err) => reportInvokeFailure('set_race_status', err));
    }
  }
}

/** Load races and keep tracking them. Returns the unsubscribe. */
export function subscribeRaceTracking(): () => void {
  void useRaceStore.getState().load().then(() => trackRaces());
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; trackRaces(); });
  };
  const unsubs = [
    useTerminalStore.subscribe((s, p) => {
      if (s.terminals !== p.terminals || s.terminalStates !== p.terminalStates) schedule();
    }),
    useAttentionStore.subscribe(schedule),
    useRaceStore.subscribe((s, p) => {
      if (s.races !== p.races || s.manualDone !== p.manualDone) schedule();
    }),
  ];
  return () => unsubs.forEach((u) => u());
}
