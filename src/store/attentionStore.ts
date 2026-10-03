import { create } from 'zustand';

export type AttentionKind = 'input' | 'review' | 'error' | 'stopped' | 'ci' | 'merged' | 'race';
/** Session items follow the agent's state and are replaced on every
 *  transition; PR items (CI failed, merged) must survive the agent getting
 *  busy again, so they live in their own slot per terminal. Race items ("Race
 *  ready to compare") sit on a contender's terminal in a slot of their own. */
export type AttentionChannel = 'session' | 'pr' | 'race';

export function channelOf(kind: AttentionKind): AttentionChannel {
  if (kind === 'race') return 'race';
  return kind === 'ci' || kind === 'merged' ? 'pr' : 'session';
}

export interface AttentionItem {
  terminalId: string;
  targetId: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  /** PR items: the pull request to open. */
  url?: string;
  /** Race items: the race whose compare view to open. */
  raceId?: string;
  createdAt: number;
}

interface AttentionStore {
  items: AttentionItem[];
  put: (item: Omit<AttentionItem, 'createdAt'>) => void;
  dismiss: (terminalId: string, channel?: AttentionChannel) => void;
  retain: (ids: Set<string>) => void;
}

const sameSlot = (a: Pick<AttentionItem, 'terminalId' | 'kind'>, terminalId: string, channel: AttentionChannel) =>
  a.terminalId === terminalId && channelOf(a.kind) === channel;

// One actionable item per terminal and channel. Dismissal lasts until a new
// state transition, so a poll of the same waiting prompt cannot recreate an item.
export const useAttentionStore = create<AttentionStore>((set) => ({
  items: [],
  put: (item) => set(s => ({ items: [
    { ...item, createdAt: Date.now() },
    ...s.items.filter(old => !sameSlot(old, item.terminalId, channelOf(item.kind))),
  ].slice(0, 200) })),
  dismiss: (id, channel = 'session') => set(s => s.items.some(item => sameSlot(item, id, channel))
    ? { items: s.items.filter(item => !sameSlot(item, id, channel)) } : {}),
  retain: (ids) => set(s => s.items.some(item => !ids.has(item.terminalId) || !ids.has(item.targetId))
    ? { items: s.items.filter(item => ids.has(item.terminalId) && ids.has(item.targetId)) } : {}),
}));
