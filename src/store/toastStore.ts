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
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string;
  removeToast: (id: string) => void;
  clearAll: () => void;
}

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 6000,
};

const MAX_TOASTS = 5;

let nextId = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++nextId}`;
    const duration = toast.duration ?? DEFAULT_DURATION[toast.type];

    set((state) => {
      const updated = [...state.toasts, { ...toast, id, duration }];
      // Keep only the most recent toasts
      return { toasts: updated.slice(-MAX_TOASTS) };
    });

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }

    return id;
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  clearAll: () => set({ toasts: [] }),
}));

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
