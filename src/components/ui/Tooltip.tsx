import { useRef, useState, useLayoutEffect, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeTooltipPosition, type TooltipSide } from '../../lib/tooltipPosition';

const SHOW_DELAY = 400;
// After a tooltip hides, moving to an adjacent control within this window
// shows its tooltip immediately (IntelliJ behavior).
const WARM_WINDOW = 300;
let warmUntil = 0;

interface TooltipProps {
  label: string;
  /** Optional dimmed shortcut chip after the label, e.g. "Ctrl+B". */
  shortcut?: string;
  side?: TooltipSide;
  /** Disable without unwrapping the children (e.g. while a menu is open). */
  disabled?: boolean;
  children: ReactNode;
}

/**
 * IntelliJ-style styled tooltip replacing native `title=`. Renders into
 * document.body so it is never clipped by overflow/truncate containers.
 * The wrapper span uses `display: contents`, so it does not affect layout;
 * the anchor rect is measured from the first element child.
 */
export function Tooltip({ label, shortcut, side = 'bottom', disabled, children }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback(() => {
    if (disabled) return;
    clearTimer();
    if (Date.now() < warmUntil) {
      setOpen(true);
    } else {
      timerRef.current = window.setTimeout(() => setOpen(true), SHOW_DELAY);
    }
  }, [disabled]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen((was) => {
      if (was) warmUntil = Date.now() + WARM_WINDOW;
      return false;
    });
    setPos(null);
  }, []);

  useEffect(() => clearTimer, []);
  useEffect(() => { if (disabled) hide(); }, [disabled, hide]);

  // A11y: removing title= must not cost screen-reader users the label on
  // icon-only controls.
  useEffect(() => {
    const el = wrapRef.current?.firstElementChild;
    if (el && !el.hasAttribute('aria-label') && !(el.textContent || '').trim()) {
      el.setAttribute('aria-label', shortcut ? `${label} (${shortcut})` : label);
    }
  }, [label, shortcut]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = wrapRef.current?.firstElementChild;
    const tipEl = tipRef.current;
    if (!anchor || !tipEl) return;
    const a = anchor.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    setPos(computeTooltipPosition(
      { left: a.left, top: a.top, width: a.width, height: a.height },
      { width: t.width, height: t.height },
      side,
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [open, side, label, shortcut]);

  return (
    <span
      ref={wrapRef}
      style={{ display: 'contents' }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={(e) => { if (e.target.matches(':focus-visible')) show(); }}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="fixed z-[90] pointer-events-none whitespace-nowrap rounded-md bg-elevation-3 ring-1 ring-[var(--ij-divider-soft)] px-2 py-1 text-[11.5px] text-text-primary shadow-lg"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {label}
            {shortcut && <span className="ml-2 text-text-tertiary">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </span>
  );
}
