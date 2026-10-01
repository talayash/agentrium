import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PrRef, PullRequestStatus } from '../lib/pullRequests';

// PRs are keyed by branch (`prKey(worktreeRoot, branch)`), not by terminal:
// every tab on the branch shows the same chip, a tab that switches branches
// stops showing it, and the poller asks gh once per branch. Refs persist, so
// chips come back with session restore; live statuses are refetched.

const MAX_REFS = 200;

interface PrStore {
  refs: Record<string, PrRef>;
  statuses: Record<string, PullRequestStatus>;
  setRef: (key: string, ref: Omit<PrRef, 'updatedAt'>) => void;
  updateRef: (key: string, patch: Partial<Omit<PrRef, 'updatedAt'>>) => void;
  removeRef: (key: string) => void;
  setStatus: (key: string, status: PullRequestStatus) => void;
}

function capped(refs: Record<string, PrRef>): Record<string, PrRef> {
  const entries = Object.entries(refs);
  if (entries.length <= MAX_REFS) return refs;
  return Object.fromEntries(entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_REFS));
}

export const usePrStore = create<PrStore>()(
  persist(
    (set) => ({
      refs: {},
      statuses: {},
      setRef: (key, ref) => set((s) => ({ refs: capped({ ...s.refs, [key]: { ...ref, updatedAt: Date.now() } }) })),
      updateRef: (key, patch) => set((s) => {
        const old = s.refs[key];
        if (!old) return {};
        return { refs: { ...s.refs, [key]: { ...old, ...patch, updatedAt: Date.now() } } };
      }),
      removeRef: (key) => set((s) => {
        if (!(key in s.refs)) return {};
        const refs = { ...s.refs };
        const statuses = { ...s.statuses };
        delete refs[key];
        delete statuses[key];
        return { refs, statuses };
      }),
      setStatus: (key, status) => set((s) => ({ statuses: { ...s.statuses, [key]: status } })),
    }),
    {
      name: 'agentrium-pull-requests',
      version: 1,
      partialize: (s) => ({ refs: s.refs }),
    },
  ),
);
