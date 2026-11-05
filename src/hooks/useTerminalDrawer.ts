import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { needsTerminal } from '../lib/terminalState';
import { readBufferTail } from './useSessionStateDetection';

export const DRAWER_POLL_MS = 500;
export const DRAWER_CLOSE_DELAY_MS = 1000;
const TAIL_ROWS = 15;

export function useTerminalDrawer(terminalId: string, enabled: boolean, questionPending: boolean) {
  const [open, setOpen] = useState(false);
  const [openedBy, setOpenedBy] = useState<'auto' | 'user' | null>(null);
  const openedByRef = useRef<'auto' | 'user' | null>(null);
  const dismissedRef = useRef(false);
  const lastNeedsRef = useRef(false);
  const calmSinceRef = useRef<number | null>(null);
  const pendingRef = useRef(questionPending);
  pendingRef.current = questionPending;

  const set = useCallback((by: 'auto' | 'user' | null) => {
    openedByRef.current = by;
    setOpen(by !== null);
    setOpenedBy(by);
    if (by === null) calmSinceRef.current = null;
  }, []);

  const openByUser = useCallback(() => set('user'), [set]);
  const close = useCallback(() => {
    // Closing an auto drawer while the need persists must not re-open it on the next poll.
    if (openedByRef.current === 'auto' && lastNeedsRef.current) dismissedRef.current = true;
    set(null);
  }, [set]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
      if (!xterm) return;
      const needs = needsTerminal(readBufferTail(xterm, TAIL_ROWS), pendingRef.current);
      lastNeedsRef.current = needs;
      if (needs) {
        calmSinceRef.current = null;
        if (openedByRef.current === null && !dismissedRef.current) set('auto');
        return;
      }
      dismissedRef.current = false;
      if (openedByRef.current === 'auto') {
        const now = Date.now();
        if (calmSinceRef.current === null) calmSinceRef.current = now;
        else if (now - calmSinceRef.current >= DRAWER_CLOSE_DELAY_MS) set(null);
      }
    }, DRAWER_POLL_MS);
    return () => {
      clearInterval(id);
      dismissedRef.current = false;
      lastNeedsRef.current = false;
      set(null);
    };
  }, [enabled, terminalId, set]);

  return { open, openedBy, openByUser, close };
}
