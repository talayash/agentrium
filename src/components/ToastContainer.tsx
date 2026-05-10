import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import type { ToastType } from '../store/toastStore';

const ICON_MAP: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLOR_MAP: Record<ToastType, { icon: string; bar: string; tint: string; ring: string }> = {
  success: {
    icon: 'text-success',
    bar: 'bg-success',
    tint: 'bg-success/10',
    ring: 'ring-success/40',
  },
  error: {
    icon: 'text-error',
    bar: 'bg-error',
    tint: 'bg-error/10',
    ring: 'ring-error/40',
  },
  warning: {
    icon: 'text-warning',
    bar: 'bg-warning',
    tint: 'bg-warning/10',
    ring: 'ring-warning/40',
  },
  info: {
    icon: 'text-accent-primary',
    bar: 'bg-accent-primary',
    tint: 'bg-accent-primary/10',
    ring: 'ring-accent-primary/40',
  },
};

function ToastItem({ id, type, title, message, duration, actions }: {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  actions?: import('../store/toastStore').ToastAction[];
}) {
  const removeToast = useToastStore((s) => s.removeToast);
  const progressRef = useRef<HTMLDivElement>(null);
  const Icon = ICON_MAP[type];
  const colors = COLOR_MAP[type];

  useEffect(() => {
    const el = progressRef.current;
    if (!el || duration <= 0) return;
    // Start the shrink animation on next frame so the transition applies
    requestAnimationFrame(() => {
      el.style.transition = `width ${duration}ms linear`;
      el.style.width = '0%';
    });
  }, [duration]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`relative overflow-hidden rounded-lg bg-elevation-3 ring-1 ${colors.ring} shadow-[0_8px_28px_rgba(0,0,0,0.6)] backdrop-blur-xl w-[320px] pointer-events-auto isolate`}
    >
      {/* Colored tint layer — sits above the opaque base so the card stays opaque */}
      <div className={`absolute inset-0 pointer-events-none ${colors.tint}`} />
      {/* Left status accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${colors.bar}`} />

      {/* Content */}
      <div className="relative flex flex-col gap-1.5 px-3 py-2.5 pl-4">
        <div className="flex items-start gap-2.5">
          <Icon size={16} className={`${colors.icon} mt-0.5 shrink-0`} />
          <div className="flex-1 min-w-0">
            <p className="text-text-primary text-[12px] font-medium leading-tight">
              {title}
            </p>
            {message && (
              <p className="text-text-secondary text-[11px] mt-0.5 leading-snug">
                {message}
              </p>
            )}
          </div>
          <button
            onClick={() => removeToast(id)}
            className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0 mt-0.5"
          >
            <X size={13} />
          </button>
        </div>
        {actions && actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 ml-6">
            {actions.map((a, i) => (
              <button
                key={i}
                onClick={() => { a.onClick(); removeToast(id); }}
                className={`text-[11px] px-2 py-1 rounded ${
                  a.primary
                    ? 'bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30'
                    : 'bg-white/5 text-text-secondary hover:bg-white/10'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Progress bar */}
      {duration > 0 && (
        <div className="relative h-[2px] w-full bg-white/[0.06]">
          <div
            ref={progressRef}
            className={`h-full ${colors.bar} opacity-70`}
            style={{ width: '100%' }}
          />
        </div>
      )}
    </motion.div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="fixed bottom-8 right-3 z-[100000] flex flex-col-reverse gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} {...t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
