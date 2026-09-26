import { forwardRef, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertTriangle, Info, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import type { Toast, ToastAction, ToastType } from '../store/toastStore';
import { bannerMotion } from '../lib/motionTokens';
import { formatRelativeTime } from '../lib/relativeTime';

const ICON_MAP: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

/* Semantic colour lives on the GLYPH ONLY - never on the surface. Tinting the
   whole card by severity makes every banner a different colour field, so the
   eye has to parse the surface before the text; it also gives each type a
   different effective text contrast. One 16px mark in a fixed position is
   readable in peripheral vision and keeps the body copy on constant ground. */
const ICON_COLOR: Record<ToastType, string> = {
  success: 'text-success',
  error: 'text-error',
  warning: 'text-warning',
  info: 'text-accent-primary',
};

/** Above this many waiting notifications the rest deck behind the newest
 *  rather than growing a wall down the side of the window. */
const COLLAPSE_THRESHOLD = 3;

/** How often the relative timestamps re-render. Coarse on purpose - the
 *  labels themselves are coarse, so a finer tick would be wasted work. */
const TICK_MS = 30_000;

function actionClasses(a: ToastAction): string {
  const variant: 'primary' | 'neutral' | 'danger' = a.variant ?? (a.primary ? 'primary' : 'neutral');
  switch (variant) {
    case 'primary':
      return 'text-white bg-gradient-to-b from-accent-secondary to-accent-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.3)] hover:brightness-110';
    case 'danger':
      return 'bg-warning/15 text-warning ring-1 ring-warning/40 hover:bg-warning/25';
    case 'neutral':
    default:
      return 'bg-fill-hover text-text-primary ring-1 ring-seam-strong hover:bg-fill-active';
  }
}

/* forwardRef is load-bearing, not ceremony: AnimatePresence mode="popLayout"
   hands a ref to its DIRECT child to measure it out of flow. A plain function
   component swallows that ref, and the exit animation then never completes -
   the card stays mounted forever. */
const ToastCard = forwardRef<HTMLDivElement, { toast: Toast; now: number }>(function ToastCard(
  { toast, now },
  ref,
) {
  const removeToast = useToastStore((s) => s.removeToast);
  const pauseAutoDismiss = useToastStore((s) => s.pauseAutoDismiss);
  const resumeAutoDismiss = useToastStore((s) => s.resumeAutoDismiss);

  const { id, type, title, message, actions, createdAt } = toast;
  const Icon = ICON_MAP[type];
  const hasActions = !!actions && actions.length > 0;

  return (
    <motion.div
      ref={ref}
      layout
      {...bannerMotion}
      // An error is the one case worth interrupting a screen reader for.
      role={type === 'error' ? 'alert' : 'status'}
      // macOS keeps a banner up as long as the pointer is on it - you should
      // never lose a notification by reading it.
      onMouseEnter={() => pauseAutoDismiss(id)}
      onMouseLeave={() => resumeAutoDismiss(id)}
      className="group material-popover pointer-events-auto w-[360px] rounded-2xl px-3.5 py-3"
    >
      <div className="flex items-start gap-3">
        <Icon size={17} strokeWidth={2.2} className={`${ICON_COLOR[type]} mt-px shrink-0`} />

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-text-primary">{title}</p>
          {message && (
            <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">{message}</p>
          )}

          {hasActions && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {actions!.map((a, i) => (
                <button
                  key={i}
                  onClick={() => {
                    a.onClick();
                    removeToast(id);
                  }}
                  className={`h-7 rounded-lg px-3.5 text-[12px] font-medium transition-[background-color,filter] duration-100 ${actionClasses(a)}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-px flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] tabular-nums text-text-tertiary">
            {formatRelativeTime(now - createdAt)}
          </span>
          {/* Revealed on hover, as in Notification Center - a permanent close
              affordance on every card turns the stack into a row of buttons. */}
          <button
            onClick={() => removeToast(id)}
            aria-label="Dismiss notification"
            className="text-text-tertiary opacity-0 transition-opacity duration-100 hover:text-text-secondary focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X size={13} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </motion.div>
  );
});

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const clearAll = useToastStore((s) => s.clearAll);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Re-render so the relative timestamps age while a banner sits on screen.
  // Only ticks while something is showing.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [toasts.length]);

  // Collapse again once the backlog drains, so the next burst starts tidy.
  useEffect(() => {
    if (toasts.length <= COLLAPSE_THRESHOLD) setExpanded(false);
  }, [toasts.length]);

  // `ordered` is newest-first, which is what the collapse logic slices against
  // (a collapsed deck keeps the NEWEST card on top of the pile).
  const ordered = [...toasts].reverse();
  const collapsed = ordered.length > COLLAPSE_THRESHOLD && !expanded;
  const visible = collapsed ? ordered.slice(0, 1) : ordered;
  const hiddenCount = ordered.length - visible.length;

  // The stack hangs off the bottom-right corner, so document order runs
  // oldest -> newest: the newest ends up nearest the corner, where it is
  // closest to the pointer and to where the eye last was.
  const rendered = [...visible].reverse();

  return (
    <div
      data-testid="notification-region"
      className="pointer-events-none fixed bottom-8 right-3 z-[100000] flex flex-col items-end gap-2.5"
    >
      {/* Controls sit ABOVE the stack - below it is the window edge. */}
      {hiddenCount > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="pointer-events-auto mb-5 mr-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
        >
          {hiddenCount} more {hiddenCount === 1 ? 'notification' : 'notifications'}
          <ChevronUp size={13} strokeWidth={2.4} />
        </button>
      )}

      {expanded && ordered.length > COLLAPSE_THRESHOLD && (
        <div className="pointer-events-auto mr-1.5 flex items-center gap-4">
          <button
            onClick={() => setExpanded(false)}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
          >
            <ChevronDown size={13} strokeWidth={2.4} />
            Collapse
          </button>
          <button
            onClick={clearAll}
            className="text-[11.5px] font-medium text-accent-secondary transition-opacity hover:opacity-80"
          >
            Clear All
          </button>
        </div>
      )}

      <div className="relative">
        {/* Deck: the notifications behind the newest. Anchored to the bottom so
            they peek out ABOVE the front card, away from the window edge. */}
        {collapsed && (
          <>
            <div className="material-popover pointer-events-none absolute inset-x-3.5 bottom-4 h-[68px] rounded-2xl opacity-50" />
            <div className="material-popover pointer-events-none absolute inset-x-[7px] bottom-2 h-[68px] rounded-2xl opacity-75" />
          </>
        )}

        <div className="relative flex flex-col items-end gap-2.5">
          <AnimatePresence mode="popLayout">
            {rendered.map((t) => (
              <ToastCard key={t.id} toast={t} now={now} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
