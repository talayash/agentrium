import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { GenerateResult, GenerateStatus, LessonCard } from '../lib/learn';

export type PanelStatus = 'idle' | 'loading' | GenerateStatus;

export interface TerminalLearn {
  status: PanelStatus;
  cards: LessonCard[];
  unseen: number;
}

interface LearnState {
  byTerminal: Record<string, TerminalLearn>;
  load: (terminalId: string) => Promise<void>;
  generate: (terminalId: string, opts?: { goal?: string; silent?: boolean }) => Promise<GenerateResult | null>;
  markSeen: (terminalId: string) => void;
  answer: (terminalId: string, cardId: string, index: number) => Promise<void>;
  toggleSave: (terminalId: string, cardId: string) => Promise<void>;
}

const EMPTY: TerminalLearn = { status: 'idle', cards: [], unseen: 0 };

export const useLearnStore = create<LearnState>((set, get) => {
  const patch = (terminalId: string, p: Partial<TerminalLearn>) =>
    set((s) => ({ byTerminal: { ...s.byTerminal, [terminalId]: { ...(s.byTerminal[terminalId] ?? EMPTY), ...p } } }));
  const patchCard = (terminalId: string, cardId: string, p: Partial<LessonCard>) => {
    const entry = get().byTerminal[terminalId];
    if (!entry) return;
    patch(terminalId, { cards: entry.cards.map((c) => (c.id === cardId ? { ...c, ...p } : c)) });
  };

  return {
    byTerminal: {},

    load: async (terminalId) => {
      try {
        const cards = await invoke<LessonCard[]>('list_learn_cards', { terminalId });
        patch(terminalId, { cards });
      } catch {
        // Best-effort read of local cards; the panel still offers Generate.
      }
    },

    generate: async (terminalId, opts = {}) => {
      patch(terminalId, { status: 'loading' });
      try {
        const res = await invoke<GenerateResult>('generate_learn_cards', { terminalId, goal: opts.goal ?? null });
        if (res.status === 'ok') {
          const cards = await invoke<LessonCard[]>('list_learn_cards', { terminalId }).catch(() => res.cards);
          patch(terminalId, { status: 'ok', cards, unseen: res.cards.length });
        } else {
          patch(terminalId, { status: res.status });
        }
        return res;
      } catch (err) {
        patch(terminalId, { status: 'failed' });
        if (!opts.silent) {
          toast.error('Could not write lessons');
          reportInvokeFailure('generate_learn_cards', err);
        }
        return null;
      }
    },

    markSeen: (terminalId) => {
      if (get().byTerminal[terminalId]?.unseen) patch(terminalId, { unseen: 0 });
    },

    answer: async (terminalId, cardId, index) => {
      patchCard(terminalId, cardId, { answeredIndex: index });
      try {
        await invoke('update_learn_card', { id: cardId, saved: null, answeredIndex: index });
      } catch (err) {
        toast.error('Could not save your answer');
        reportInvokeFailure('update_learn_card', err);
      }
    },

    toggleSave: async (terminalId, cardId) => {
      const card = get().byTerminal[terminalId]?.cards.find((c) => c.id === cardId);
      if (!card) return;
      const next = !card.saved;
      patchCard(terminalId, cardId, { saved: next });
      try {
        await invoke('update_learn_card', { id: cardId, saved: next, answeredIndex: null });
      } catch (err) {
        patchCard(terminalId, cardId, { saved: !next });
        toast.error('Could not save the card');
        reportInvokeFailure('update_learn_card', err);
      }
    },
  };
});
