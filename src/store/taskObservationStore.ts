import { create } from 'zustand';
import type { TaskObservation } from '../lib/reviewQueue';

// Last observed `get_task_status` per task terminal, for Review Queue
// evidence. Live only: refetched on start, never persisted or synced.
interface TaskObservationStore {
  byTerminal: Record<string, TaskObservation>;
  set: (terminalId: string, obs: TaskObservation) => void;
  retain: (ids: Set<string>) => void;
}

export const useTaskObservationStore = create<TaskObservationStore>((set) => ({
  byTerminal: {},
  set: (terminalId, obs) => set(s => ({ byTerminal: { ...s.byTerminal, [terminalId]: obs } })),
  retain: (ids) => set(s => Object.keys(s.byTerminal).some(id => !ids.has(id))
    ? { byTerminal: Object.fromEntries(Object.entries(s.byTerminal).filter(([id]) => ids.has(id))) } : {}),
}));
