// 500ms tick used by the tab strip to re-evaluate the active-work indicator.
// The interval auto-stops when no terminal has been active in the last 5s, so
// an idle app pays zero per-frame cost.

import { useEffect, useState } from 'react';
import { getActiveTerminalIds } from '../lib/terminalActivity';

const ACTIVE_WINDOW_MS = 5000;
const TICK_MS = 500;

export function useNowTick(): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval) return;
      interval = setInterval(() => {
        setNow(Date.now());
        if (getActiveTerminalIds(ACTIVE_WINDOW_MS).length === 0 && interval) {
          clearInterval(interval);
          interval = null;
        }
      }, TICK_MS);
    };

    // Poll once a second to catch new bursts of activity without subscribing to
    // every terminal-output event. Cheap, bounded.
    const watchdog = setInterval(() => {
      if (!interval && getActiveTerminalIds(ACTIVE_WINDOW_MS).length > 0) start();
    }, 1000);

    start();

    return () => {
      clearInterval(watchdog);
      if (interval) clearInterval(interval);
    };
  }, []);

  return now;
}
