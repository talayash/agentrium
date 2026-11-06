import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { useContextUsageStore } from '../store/contextUsageStore';
import type { ContextUsage } from '../lib/contextMeter';

export const CONTEXT_POLL_MS = 4000;

/**
 * Polls `get_context_usage` for every open terminal while the context meter
 * is enabled. The Rust side only re-reads a transcript after it grows, so a
 * tick is mostly a file `stat` per session. Mount once (App).
 */
export function useContextUsagePoller(): void {
  const enabled = useAppStore((s) => s.contextMeterEnabled);

  useEffect(() => {
    const store = useContextUsageStore.getState();
    if (!enabled) {
      store.clear();
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.hidden) return;
      const ids = [...useTerminalStore.getState().terminals.keys()];
      if (ids.length === 0) {
        store.replace({});
        return;
      }
      inFlight = true;
      invoke<Record<string, ContextUsage>>('get_context_usage', { ids })
        .then((res) => {
          if (!cancelled) useContextUsageStore.getState().replace(res);
        })
        // Background poller: a failed tick keeps the last reading and the next
        // tick retries; Rust already reports real read failures via report_bg.
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, CONTEXT_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}
