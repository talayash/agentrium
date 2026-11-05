import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';
import { needsTerminal } from '../lib/terminalState';
import { readBufferTail } from './useSessionStateDetection';

export const DRAWER_POLL_MS = 500;
export const DRAWER_CLOSE_DELAY_MS = 1000;
const TAIL_ROWS = 15;

export function useTerminalDrawer(terminalId: string, enabled: boolean, questionPending: boolean) {
  const [open, setOpen] = useState(false);
  const [openedBy, setOpenedBy] = useState<'auto' | 'user' | null>(null);
  const openedByRef = useRef<'auto' | 'user' | null>(null);
  const requestedRef = useRef(false);
  const calmSinceRef = useRef<number | null>(null);
  const pendingRef = useRef(questionPending);
  pendingRef.current = questionPending;

  const set = useCallback((by: 'auto' | 'user' | null) => {
    openedByRef.current = by;
    setOpen(by !== null);
    setOpenedBy(by);
    if (by === null) { requestedRef.current = false; calmSinceRef.current = null; }
  }, []);

  const openByUser = useCallback(() => set('user'), [set]);
  const close = useCallback(() => set(null), [set]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const state = useTerminalStore.getState();
      const xterm = state.terminals.get(terminalId)?.xterm;
      if (!xterm) return;
      const needs = needsTerminal(readBufferTail(xterm, TAIL_ROWS), pendingRef.current);
      if (needs) {
        calmSinceRef.current = null;
        if (openedByRef.current === null) set('auto');
        if (openedByRef.current === 'auto' && !requestedRef.current) {
          requestedRef.current = true;
          if (state.activeTerminalId !== terminalId) useSessionAttentionStore.getState().request(terminalId);
        }
      } else if (openedByRef.current === 'auto') {
        const now = Date.now();
        if (calmSinceRef.current === null) calmSinceRef.current = now;
        else if (now - calmSinceRef.current >= DRAWER_CLOSE_DELAY_MS) set(null);
      }
    }, DRAWER_POLL_MS);
    return () => {
      clearInterval(id);
      set(null);
    };
  }, [enabled, terminalId, set]);

  return { open, openedBy, openByUser, close };
}
