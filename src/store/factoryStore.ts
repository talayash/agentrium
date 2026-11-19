import { create } from 'zustand';
import {
  answerFactoryGate, cancelFactoryCheck, controlFactoryRun, evaluateFactoryStation, holdsLine, isOpenRun,
  listFactories, listFactoryRuns, needsYou, startFactoryRun,
  type Factory, type FactoryRun, type RunControl, type RunStep,
} from '../lib/factory';
import { kickQueue, performStep } from '../lib/factoryActions';
import { reportInvokeFailure } from '../lib/errorReporter';
import { toast } from './toastStore';
import { useTerminalStore } from './terminalStore';
import { useAppStore } from './appStore';
import { BUSY_GRACE_MS } from './raceStore';

interface FactoryStoreState {
  factories: Record<string, Factory>;
  runs: Record<string, FactoryRun>;
  loaded: boolean;
  /** Run id -> eval id of the evaluation in flight. A run is evaluating while it has an entry. */
  evaluating: Record<string, string>;
  /** Terminal ids seen busy since their station started. */
  seenBusy: Record<string, true>;
  /** Exited terminal ids already evaluated once, so an exited session is not re-checked on every pass. */
  exitHandled: Record<string, true>;
  /** Terminal id -> when performStep opened it as a station session (ms). */
  sessionOpenedAt: Record<string, number>;

  load: () => Promise<void>;
  markSessionOpened: (terminalId: string, at?: number) => void;
  upsertFactory: (f: Factory) => void;
  /** Drop a deleted factory and its runs (the backend deletes them with it). */
  removeFactory: (id: string) => void;
  /** Store the run, perform the step, then kick the queue when the run no longer holds the line. */
  applyStep: (step: RunStep) => Promise<void>;
  startRun: (factoryId: string, input: string) => Promise<FactoryRun>;
  evaluate: (runId: string, manual: boolean) => Promise<void>;
  answerGate: (runId: string, stepId: string, approve: boolean, reason: string) => Promise<void>;
  control: (runId: string, op: RunControl) => Promise<void>;
}

const without = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...rec };
  delete next[key];
  return next;
};

export const useFactoryStore = create<FactoryStoreState>((set, get) => ({
  factories: {},
  runs: {},
  loaded: false,
  evaluating: {},
  seenBusy: {},
  exitHandled: {},
  sessionOpenedAt: {},

  load: async () => {
    try {
      const [factoryList, runList] = await Promise.all([listFactories(), listFactoryRuns()]);
      const factories: Record<string, Factory> = {};
      const runs: Record<string, FactoryRun> = {};
      for (const f of factoryList) factories[f.id] = f;
      for (const r of runList) runs[r.id] = r;
      set({ factories, runs, loaded: true });
      // A queued run whose kick was lost (for example to a crash) starts now.
      const stalled = Object.keys(factories).filter((id) => {
        const own = runList.filter((r) => r.factoryId === id);
        return own.some((r) => r.status === 'queued') && !own.some(holdsLine);
      });
      await Promise.all(stalled.map((id) => kickQueue(id)));
    } catch (err) {
      // Startup load: the sidebar and floor just show no factories.
      reportInvokeFailure('list_factories', err);
      set({ loaded: true });
    }
  },

  markSessionOpened: (terminalId, at = Date.now()) =>
    set((s) => ({ sessionOpenedAt: { ...s.sessionOpenedAt, [terminalId]: at } })),

  upsertFactory: (f) => set((s) => ({ factories: { ...s.factories, [f.id]: f } })),

  removeFactory: (id) => set((s) => ({
    factories: without(s.factories, id),
    runs: Object.fromEntries(Object.entries(s.runs).filter(([, r]) => r.factoryId !== id)),
  })),

  applyStep: async (step) => {
    const { run, action } = step;
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
    await performStep(step, get().factories[run.factoryId]?.name ?? run.definition.name);
    // A queued run never kicks: the line is busy, and it would only re-queue itself.
    if (!holdsLine(run) && action.kind !== 'queued') await kickQueue(run.factoryId);
  },

  startRun: async (factoryId, input) => {
    const step = await startFactoryRun(factoryId, input);
    await get().applyStep(step);
    return get().runs[step.run.id] ?? step.run;
  },

  evaluate: async (runId, manual) => {
    if (get().evaluating[runId]) return;
    const evalId = crypto.randomUUID();
    set((s) => ({ evaluating: { ...s.evaluating, [runId]: evalId } }));
    try {
      const step = await evaluateFactoryStation(runId, manual, evalId);
      const terminalId = step.run.terminalId;
      if (step.action.kind === 'waiting' && terminalId) {
        // Re-arm: the next busy-to-idle edge evaluates again.
        set((s) => ({ seenBusy: without(s.seenBusy, terminalId) }));
      }
      await get().applyStep(step);
    } catch (err) {
      if (manual) {
        toast.error('Check did not run', String(err));
        reportInvokeFailure('evaluate_factory_station', err);
      }
      // background evaluation: the user can press Check now
    } finally {
      set((s) => (s.evaluating[runId] === evalId ? { evaluating: without(s.evaluating, runId) } : {}));
    }
  },

  answerGate: async (runId, stepId, approve, reason) => {
    try {
      const step = await answerFactoryGate(runId, stepId, approve, reason.trim() || null);
      await get().applyStep(step);
    } catch (err) {
      toast.error('Could not answer the gate', String(err));
      reportInvokeFailure('answer_factory_gate', err);
      throw err;
    }
  },

  control: async (runId, op) => {
    const evalId = get().evaluating[runId];
    if (evalId && (op === 'cancel' || op === 'resume')) {
      await cancelFactoryCheck(evalId).catch(() => {
        // best effort: a late result is ignored by the backend anyway
      });
    }
    const step = await controlFactoryRun(runId, op);
    await get().applyStep(step);
  },
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function needsYouCount(runs: Record<string, FactoryRun>): number {
  return Object.values(runs).filter(needsYou).length;
}

/** A factory's runs: open runs first, then newest first. */
export function runsForFactory(runs: Record<string, FactoryRun>, factoryId: string): FactoryRun[] {
  return Object.values(runs)
    .filter((r) => r.factoryId === factoryId)
    .sort((a, b) => Number(isOpenRun(b)) - Number(isOpenRun(a)) || b.createdAt.localeCompare(a.createdAt));
}

/** The run's station session is open in this app session and its process has not exited. */
export function hasLiveSession(run: FactoryRun): boolean {
  if (!run.terminalId) return false;
  const t = useTerminalStore.getState().terminals.get(run.terminalId);
  return !!t && t.config.status !== 'Stopped' && t.config.status !== 'Error';
}

// ---------------------------------------------------------------------------
// Tracking: evaluate a station once its agent finished a turn
// ---------------------------------------------------------------------------

/**
 * One pass over every running run. Exported for tests. A terminal counts as
 * seen busy only when it is busy at least BUSY_GRACE_MS after its station
 * session opened, so a startup blip never arms an evaluation.
 */
export function trackFactoryRuns(now = Date.now()): void {
  const { terminals, terminalStates } = useTerminalStore.getState();
  for (const run of Object.values(useFactoryStore.getState().runs)) {
    if (run.status !== 'running' || !run.terminalId) continue;
    const id = run.terminalId;
    const t = terminals.get(id);
    if (!t) continue;
    const state = terminalStates.get(id);
    if (state === 'busy' && !useFactoryStore.getState().seenBusy[id]) {
      // No entry (for example after a hot reload): fall back to the terminal's creation time.
      const opened = useFactoryStore.getState().sessionOpenedAt[id] ?? Date.parse(t.config.created_at);
      if (!Number.isNaN(opened) && now - opened >= BUSY_GRACE_MS) {
        useFactoryStore.setState((s) => ({ seenBusy: { ...s.seenBusy, [id]: true } }));
      }
    }
    const s = useFactoryStore.getState();
    if (s.evaluating[run.id]) continue;
    const exited = t.config.status === 'Stopped' || t.config.status === 'Error';
    if (exited) {
      if (s.exitHandled[id]) continue;
      useFactoryStore.setState((p) => ({ exitHandled: { ...p.exitHandled, [id]: true } }));
      void s.evaluate(run.id, false);
    } else if (s.seenBusy[id] && state === 'idle') {
      void s.evaluate(run.id, false);
    }
  }
}

/** Load factories and runs and keep tracking them. Returns the unsubscribe. */
export function subscribeFactoryTracking(): () => void {
  if (!useAppStore.getState().factoryEnabled) return () => {};
  void useFactoryStore.getState().load().then(() => trackFactoryRuns());
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; trackFactoryRuns(); });
  };
  const unsubs = [
    useTerminalStore.subscribe((s, p) => {
      if (s.terminals !== p.terminals || s.terminalStates !== p.terminalStates) schedule();
    }),
    useFactoryStore.subscribe((s, p) => {
      // An idle edge that landed during an evaluation is picked up once it finishes.
      if (s.runs !== p.runs || s.evaluating !== p.evaluating) schedule();
    }),
  ];
  return () => unsubs.forEach((u) => u());
}
