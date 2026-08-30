import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { overlayMotion, dialogMotion } from '../../lib/motionTokens';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Header title (only rendered when `showHeader`). */
  title?: ReactNode;
  /** Leading header icon (only rendered when `showHeader`). */
  icon?: ReactNode;
  /** Render the standard header bar (title + close button). */
  showHeader?: boolean;
  /** How clicking the scrim dismisses the modal. Default 'click'. */
  closeOn?: 'click' | 'doubleClick' | 'none';
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Tailwind sizing for the panel, e.g. 'w-full max-w-3xl'. */
  panelClassName?: string;
  /** Extra classes for the scrim (z-index, tint). */
  scrimClassName?: string;
}

/**
 * Shared modal shell: animated scrim + panel, optional header, Escape + scrim
 * dismissal. Collapses the backdrop/panel/animation boilerplate that each
 * dialog used to re-implement. Relies on a parent <AnimatePresence> for exit
 * animations (same as the modals it replaces).
 */
export function Modal({
  onClose,
  children,
  title,
  icon,
  showHeader = false,
  closeOn = 'click',
  closeOnEscape = true,
  panelClassName = 'w-full max-w-lg',
  scrimClassName = 'bg-black/55 z-50',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeOnEscape, onClose]);

  // Focus management: move focus into the dialog on open, trap Tab within it,
  // and restore focus to the trigger on close. Without this, Tab escapes behind
  // the scrim and focus is never returned - a keyboard/screen-reader trap.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const getFocusable = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];

    const first = getFocusable()[0];
    if (first) first.focus();
    else panel?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel) return;
      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === firstEl || !panel.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (active === lastEl || !panel.contains(active)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  const onScrimClick = (e: MouseEvent) => {
    if (closeOn === 'click' && e.target === e.currentTarget) onClose();
  };
  const onScrimDoubleClick = (e: MouseEvent) => {
    if (closeOn === 'doubleClick' && e.target === e.currentTarget) onClose();
  };

  return (
    <motion.div
      {...overlayMotion}
      className={`fixed inset-0 flex items-center justify-center backdrop-blur-[3px] ${scrimClassName}`}
      onClick={onScrimClick}
      onDoubleClick={onScrimDoubleClick}
    >
      <motion.div
        {...dialogMotion}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        // Stop bubbling so clicks inside the panel never reach the scrim handler.
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`material-sheet rounded-xl overflow-hidden ${panelClassName}`}
      >
        {showHeader && (
          <div className="flex items-center justify-between px-4 h-11 border-b border-[var(--seam)]">
            <div className="flex items-center gap-2 min-w-0">
              {icon}
              <h2 className="text-text-primary text-[14px] font-semibold tracking-title truncate">{title}</h2>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-full hover:bg-fill-active active:bg-fill-active active:scale-95 text-text-tertiary hover:text-text-secondary transition-[background-color,color,transform] duration-100"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {children}
      </motion.div>
    </motion.div>
  );
}
