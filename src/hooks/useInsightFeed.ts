import { useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { buildInsightModel, type InsightModel, type InsightRecord } from '../lib/insightModel';
import { useInsightStore } from '../store/insightStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';

const FLUSH_MS = 300;
const NO_RECORDS: InsightRecord[] = [];

interface InsightPayload { id: string; records: InsightRecord[]; reset: boolean }

/** Tails the terminal's transcript while `enabled`. When disabled it does nothing at all. */
export function useInsightFeed(terminalId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buffer: { records: InsightRecord[]; reset: boolean } | null = null;

    const flush = () => {
      timer = undefined;
      if (!buffer) return;
      const { records, reset } = buffer;
      buffer = null;
      useInsightStore.getState().append(terminalId, records, reset);
    };

    listen<InsightPayload>('insight-records', (event) => {
      if (event.payload.id !== terminalId) return;
      const { records, reset } = event.payload;
      // A reset drops anything buffered before it.
      buffer = reset || !buffer
        ? { records: [...records], reset }
        : { records: [...buffer.records, ...records], reset: buffer.reset };
      if (timer === undefined) timer = setTimeout(flush, FLUSH_MS);
    }).then((fn) => {
      if (!active) {
        fn(); // effect already cleaned up before the listener resolved
        return;
      }
      unlisten = fn;
      // Start only once the listener is registered: the tailer's initial reset
      // batch is never re-sent, so it must not be emitted before we listen.
      return invoke<{ supported: boolean }>('insight_start', { id: terminalId })
        .then((res) => {
          if (active) useInsightStore.getState().setSupported(terminalId, res.supported);
        });
    }).catch((err) => {
      // User-initiated (they turned the layer on): a failed listen or start is surfaced, and the panel shows the fallback.
      if (!active) return;
      toast.error('Could not start the insight layer', String(err));
      reportInvokeFailure('insight_start', err);
      useInsightStore.getState().setSupported(terminalId, false);
    });

    return () => {
      active = false;
      unlisten?.();
      if (timer !== undefined) clearTimeout(timer);
      buffer = null;
      // Best-effort: the Rust loop also exits when the terminal closes.
      invoke('insight_stop', { id: terminalId }).catch(() => {});
    };
  }, [terminalId, enabled]);
}

/** Insight model for a terminal; rebuilt only when its records array changes. */
export function useInsightModel(terminalId: string): InsightModel {
  const records = useInsightStore(s => s.byId.get(terminalId)?.records) ?? NO_RECORDS;
  return useMemo(() => buildInsightModel(records), [records]);
}
