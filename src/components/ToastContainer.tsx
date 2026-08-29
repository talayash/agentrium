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

function actionClasses(a: import('../store/toastStore').ToastAction): string {
  const variant: 'primary' | 'neutral' | 'danger' = a.variant ?? (a.primary ? 'primary' : 'neutral');
  switch (variant) {
    case 'primary':
      return 'bg-accent-primary text-white hover:bg-accent-primary/90 shadow-[0_2px_6px_rgba(0,0,0,0.3)]';
    case 'danger':
      return 'bg-warning/15 text-warning ring-1 ring-warning/40 hover:bg-warning/25';
    case 'neutral':
    default:
      return 'bg-fill-hover text-text-primary ring-1 ring-seam-strong hover:bg-fill-active';
  }
}

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
  const hasActions = !!actions && actions.length > 0;

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
      initial={{ opacity: 0, x: 88, scale: 0.96 }}
      animate={{
        opacity: 1,
        x: 0,
        scale: 1,
        // Arrives with momentum - a slight settle is earned here.
        transition: { type: 'spring', bounce: 0.18, duration: 0.42, opacity: { duration: 0.15, ease: 'easeOut' } },
      }}
      exit={{ opacity: 0, x: 88, scale: 0.96, transition: { duration: 0.16, ease: 'easeOut' } }}
      className={`relative overflow-hidden rounded-lg bg-elevation-3 ring-1 ${colors.ring} shadow-elevation-3 pointer-events-auto isolate ${
        hasActions ? 'w-[420px]' : 'w-[320px]'
      }`}
    >
      {/* Colored tint layer - sits above the opaque base so the card stays opaque */}
      <div className={`absolute inset-0 pointer-events-none ${colors.tint}`} />
      {/* Left status accent bar - thicker when the toast has actions so it
          reads as a decision card, not a passing notification */}
      <div className={`absolute left-0 top-0 bottom-0 ${hasActions ? 'w-[5px]' : 'w-[3px]'} ${colors.bar}`} />

      {/* Content */}
      <div className={`relative flex flex-col ${hasActions ? 'gap-2.5 px-4 py-3 pl-5' : 'gap-1.5 px-3 py-2.5 pl-4'}`}>
        <div className={`flex items-start ${hasActions ? 'gap-3' : 'gap-2.5'}`}>
          <Icon size={hasActions ? 20 : 16} className={`${colors.icon} ${hasActions ? 'mt-0.5' : 'mt-0.5'} shrink-0`} />
          <div className="flex-1 min-w-0">
            <p className={`text-text-primary font-semibold leading-tight ${hasActions ? 'text-[13px]' : 'text-[12px]'}`}>
              {title}
            </p>
            {message && (
              <p className={`text-text-secondary mt-1 leading-snug ${hasActions ? 'text-[12px]' : 'text-[11px] mt-0.5'}`}>
                {message}
              </p>
            )}
          </div>
          <button
            onClick={() => removeToast(id)}
            className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0 mt-0.5"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
        {hasActions && (
          <div className="flex flex-wrap gap-2 mt-0.5">
            {actions!.map((a, i) => (
              <button
                key={i}
                onClick={() => { a.onClick(); removeToast(id); }}
                className={`text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors ${actionClasses(a)}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Progress bar */}
      {duration > 0 && (
        <div className="relative h-[2px] w-full bg-fill-hover">
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
