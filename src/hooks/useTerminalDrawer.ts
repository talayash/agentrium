import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { needsTerminal } from '../lib/terminalState';
import { questionOnScreen, readBufferTail } from '../lib/terminalScreen';
import type { AskQuestion } from '../lib/insightModel';

export const DRAWER_POLL_MS = 500;
export const DRAWER_CLOSE_DELAY_MS = 1000;
const TAIL_ROWS = 15;

/**
 * Insight mode's terminal drawer. Polls the hidden terminal's screen and
 * reports:
 * - `needs`: the terminal needs the user (prompt, option menu, bare shell);
 *   auto-opens the drawer unless the user dismissed it for this episode.
 * - `questionShown`: `question` (the pending AskUserQuestion) is really on
 *   screen. A stale question that is no longer on screen counts as not shown,
 *   so it never blocks the prompt bar or suppresses the drawer.
 */
export function useTerminalDrawer(terminalId: string, enabled: boolean, question: AskQuestion | null | undefined) {
  const [open, setOpen] = useState(false);
  const [openedBy, setOpenedBy] = useState<'auto' | 'user' | null>(null);
  const [needs, setNeeds] = useState(false);
  const [questionShown, setQuestionShown] = useState(() => !!question && questionOnScreen(terminalId, question));
  const openedByRef = useRef<'auto' | 'user' | null>(null);
  const dismissedRef = useRef(false);
  const lastNeedsRef = useRef(false);
  const calmSinceRef = useRef<number | null>(null);
  const questionRef = useRef(question);
  questionRef.current = question;

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

  // A new (or cleared) question is re-checked right away, not on the next poll.
  useEffect(() => {
    setQuestionShown(!!question && questionOnScreen(terminalId, question));
  }, [terminalId, question]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
      if (!xterm) return;
      const q = questionRef.current;
      const shown = !!q && questionOnScreen(terminalId, q);
      setQuestionShown(shown);
      const needs = needsTerminal(readBufferTail(xterm, TAIL_ROWS), shown);
      lastNeedsRef.current = needs;
      setNeeds(needs);
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
      setNeeds(false);
      set(null);
    };
  }, [enabled, terminalId, set]);

  return { open, openedBy, openByUser, close, needs, questionShown };
}
