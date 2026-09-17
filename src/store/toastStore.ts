import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Visual treatment. `primary` is recommended action (solid accent),
   * `neutral` is a regular alternative, `danger` is destructive/disabling
   * (amber tint). Defaults to `neutral`. The legacy `primary: true` flag
   * is still honored for backwards compatibility. */
  variant?: 'primary' | 'neutral' | 'danger';
  primary?: boolean;
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  actions?: ToastAction[];
  /** Epoch ms the toast was raised - drives the relative timestamp the
   *  banner renders ("now", "2m"). */
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'duration' | 'createdAt'> & { duration?: number }) => string;
  removeToast: (id: string) => void;
  clearAll: () => void;
  /** Hold a toast's auto-dismiss while the pointer is over it (macOS keeps a
   *  banner up as long as you're looking at it). Idempotent; a no-op for a
   *  toast that never auto-dismisses. */
  pauseAutoDismiss: (id: string) => void;
  /** Resume a paused toast with only the time that was left, not a fresh
   *  full duration. */
  resumeAutoDismiss: (id: string) => void;
}

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 6000,
};

const MAX_TOASTS = 5;

let nextId = 0;

/** Live auto-dismiss timers, keyed by toast id. `remaining` is non-null only
 *  while the toast is paused under the pointer. Kept outside the store: a
 *  timer handle is not state anything renders from. */
interface DismissTimer {
  handle: ReturnType<typeof setTimeout>;
  endsAt: number;
  remaining: number | null;
}
const timers = new Map<string, DismissTimer>();

function cancelTimer(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer.handle);
  timers.delete(id);
}

export const useToastStore = create<ToastState>()((set) => {
  const scheduleDismiss = (id: string, ms: number): void => {
    const handle = setTimeout(() => {
      timers.delete(id);
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, ms);
    timers.set(id, { handle, endsAt: Date.now() + ms, remaining: null });
  };

  return {
    toasts: [],

    addToast: (toast) => {
      const id = `toast-${++nextId}`;
      // A toast carrying actions asks the user a question, so it waits for an
      // answer instead of expiring mid-read. An explicit duration still wins.
      const hasActions = !!toast.actions && toast.actions.length > 0;
      const duration = toast.duration ?? (hasActions ? 0 : DEFAULT_DURATION[toast.type]);

      set((state) => {
        const updated = [...state.toasts, { ...toast, id, duration, createdAt: Date.now() }];
        // Keep only the most recent toasts
        const kept = updated.slice(-MAX_TOASTS);
        // Evicted toasts will never be rendered again - drop their timers so
        // the map can't grow without bound in a long-lived session.
        for (const evicted of updated.slice(0, updated.length - kept.length)) {
          cancelTimer(evicted.id);
        }
        return { toasts: kept };
      });

      // Auto-dismiss
      if (duration > 0) {
        scheduleDismiss(id, duration);
      }

      return id;
    },

    removeToast: (id) => {
      cancelTimer(id);
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    },

    clearAll: () => {
      for (const id of [...timers.keys()]) cancelTimer(id);
      set({ toasts: [] });
    },

    pauseAutoDismiss: (id) => {
      const timer = timers.get(id);
      if (!timer || timer.remaining !== null) return;
      clearTimeout(timer.handle);
      timer.remaining = Math.max(0, timer.endsAt - Date.now());
    },

    resumeAutoDismiss: (id) => {
      const timer = timers.get(id);
      if (!timer || timer.remaining === null) return;
      scheduleDismiss(id, timer.remaining);
    },
  };
});

type ToastOpts = { duration?: number; actions?: ToastAction[] };

// Convenience functions for use outside React components
export const toast = {
  success: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'success', title, message, ...opts }),
  error: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'error', title, message, ...opts }),
  warning: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'warning', title, message, ...opts }),
  info: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'info', title, message, ...opts }),
};
