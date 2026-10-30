import { create } from 'zustand';

export interface ReviewComment {
  id: string;
  terminalId: string;
  filePath: string;
  side: 'new' | 'old';
  line: number;
  snippet: string;
  body: string;
}

interface ReviewStore {
  comments: ReviewComment[];
  add: (c: Omit<ReviewComment, 'id'>) => string;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  clearFor: (terminalId: string) => void;
}

// In memory only: review comments are never persisted or synced.
export const useReviewStore = create<ReviewStore>((set) => ({
  comments: [],
  add: (c) => {
    const id = crypto.randomUUID();
    set((s) => ({ comments: [...s.comments, { ...c, id }] }));
    return id;
  },
  update: (id, body) =>
    set((s) => ({ comments: s.comments.map((c) => (c.id === id ? { ...c, body } : c)) })),
  remove: (id) => set((s) => ({ comments: s.comments.filter((c) => c.id !== id) })),
  clearFor: (terminalId) =>
    set((s) => ({ comments: s.comments.filter((c) => c.terminalId !== terminalId) })),
}));

export function commentsFor(terminalId: string): ReviewComment[] {
  return useReviewStore.getState().comments.filter((c) => c.terminalId === terminalId);
}
