import { invoke } from '@tauri-apps/api/core';
import {
  WebviewWindow,
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';
import { useTerminalStore } from '../store/terminalStore';
import type { TerminalConfig } from '../store/terminalStore';
import type { WindowGeometry } from './windowLayout';
import { reportError } from './errorReporter';

const TRANSFER_EVENT = 'ct://tab-transfer';
const TRANSFER_DONE_EVENT = 'ct://tab-transfer-done';
const CANCEL_EVENT = 'ct://tab-transfer-cancel';
const transferringIds = new Set<string>();
const READY_EVENT = 'ct://tab-transfer-ready';
const TRANSFER_TIMEOUT_MS = 15000;

interface TransferPayload {
  targetLabel: string;
  ids: string[];
  sourceLabel: string;
  requestId: string;
  expiresAt: number;
}
interface TransferDonePayload {
  ids: string[];
  byLabel: string;
  requestId: string;
  error?: string;
}

/** Register before sending/creating so even a fast response cannot be missed. */
async function waitForEvent<T>(name: string, matches: (payload: T) => boolean) {
  let resolve!: (payload: T) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A creation error can reject while the caller is still awaiting setup.
  void result.catch(() => {});
  const unlisten = await listen<T>(name, event => { if (matches(event.payload)) resolve(event.payload); });
  const timer = setTimeout(() => reject(new Error('Tab transfer timed out; the source tabs were retained.')), TRANSFER_TIMEOUT_MS);
  return { result, fail: reject, dispose: () => { clearTimeout(timer); unlisten(); } };
}

async function openDetachedWindow(ids: string[], geometry?: WindowGeometry, position?: [number, number]): Promise<void> {
  if (ids.length === 0) return;
  const label = `detached-${crypto.randomUUID()}`;
  const ready = await waitForEvent<{ label: string }>(READY_EVENT, payload => payload.label === label);
  let win: WebviewWindow | undefined;
  const unlisteners: Array<() => void> = [];
  try {
    // The destination boots empty and announces readiness only after its
    // transfer receiver is registered. It never adopts URL IDs speculatively.
    win = new WebviewWindow(label, {
      url: 'index.html?mode=detached', width: 1000, height: 680,
      minWidth: 480, minHeight: 320, decorations: false, transparent: true, title: 'Agentrium',
    });
    unlisteners.push(await win.once('tauri://error', e => ready.fail(new Error(`Window creation failed: ${JSON.stringify(e.payload)}`))));
    await ready.result;
    if (geometry) {
      await win.setPosition(new PhysicalPosition(Math.round(geometry.x), Math.round(geometry.y))).catch(() => {});
      await win.setSize(new PhysicalSize(Math.round(geometry.w), Math.round(geometry.h))).catch(() => {});
    } else if (position) {
      await win.setPosition(new PhysicalPosition(Math.round(position[0]), Math.round(position[1]))).catch(() => {});
    }
    await requestTransfer(label, ids, getCurrentWebviewWindow().label);
  } catch (err) {
    await win?.close().catch(() => {});
    reportError('window_create', String(err));
    throw err;
  } finally {
    ready.dispose();
    unlisteners.forEach(fn => fn());
  }
}

export async function createDetachedWindow(ids: string[], physX: number, physY: number): Promise<void> {
  await openDetachedWindow(ids, undefined, [physX, physY]);
}

export async function restoreDetachedWindow(ids: string[], geometry?: WindowGeometry): Promise<void> {
  await openDetachedWindow(ids, geometry);
}

/**
 * Route a dropped set of tabs. Reads the global cursor position and hit-tests
 * it against every window's outer bounds:
 *   - over another window  → emit a transfer to that window;
 *   - over the source only → no-op (an in-strip reorder was already handled);
 *   - outside all windows  → open a new detached window at the cursor.
 */
export async function routeTabDrop(ids: string[], sourceLabel: string): Promise<void> {
  if (ids.length === 0) return;

  let cx = 0;
  let cy = 0;
  try {
    const pos = await invoke<[number, number]>('get_cursor_position');
    [cx, cy] = pos;
  } catch (err) {
    console.error('[tabTransfer] get_cursor_position failed:', err);
    return;
  }

  let target: string | null = null;
  const windows = await getAllWebviewWindows();
  for (const w of windows) {
    if (w.label === sourceLabel) continue; // can't transfer into yourself
    if (w.label === 'drag-preview') continue; // the floating overlay isn't a target
    try {
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      const inside =
        cx >= pos.x && cx <= pos.x + size.width && cy >= pos.y && cy <= pos.y + size.height;
      if (inside) {
        target = w.label;
        break;
      }
    } catch {
      // Window may have closed mid-drag - skip it.
    }
  }

  if (target) {
    // Dropped over another window → transfer the tab(s) there.
    await requestTransfer(target, ids, sourceLabel);
  } else {
    // Dropped over the source window's own body, or empty desktop → tear off a
    // new window at the cursor. (Drops over the source's tab strip are handled
    // as a reorder before routeTabDrop is ever called.)
    await createDetachedWindow(ids, cx, cy);
  }

}

/**
 * Explicitly request that `targetLabel` adopt the given ids (e.g. a detached
 * window returning its tabs to 'main' when it closes). The target's receiver
 * adopts them and broadcasts the "done" that releases them from this window.
 */
export async function requestTransfer(targetLabel: string, ids: string[], sourceLabel: string): Promise<void> {
  if (ids.length === 0 || targetLabel === sourceLabel) return;
  if (ids.some(id => transferringIds.has(id))) throw new Error('These tabs are already being transferred');
  ids.forEach(id => transferringIds.add(id));
  const requestId = crypto.randomUUID();
  let ack: Awaited<ReturnType<typeof waitForEvent<TransferDonePayload>>> | undefined;
  try {
    ack = await waitForEvent<TransferDonePayload>(TRANSFER_DONE_EVENT, p => p.requestId === requestId && p.byLabel === targetLabel);
    await emit(TRANSFER_EVENT, { targetLabel, ids, sourceLabel, requestId, expiresAt: Date.now() + TRANSFER_TIMEOUT_MS } as TransferPayload);
    const result = await ack.result;
    if (result.error) throw new Error(result.error);
    if (ids.some(id => !result.ids.includes(id))) throw new Error('Destination did not adopt all tabs');
    useTerminalStore.getState().detachTerminals(ids);
  } catch (err) {
    // Roll back a destination that acknowledged just as the source timed out.
    await emit(CANCEL_EVENT, { targetLabel, requestId }).catch(() => {});
    throw err;
  } finally {
    ack?.dispose();
    ids.forEach(id => transferringIds.delete(id));
  }
}

/**
 * Wire a window into the transfer protocol. Returns an unlisten function.
 *   - `adopt`  registers a terminal whose PTY already exists (seeds scrollback).
 *   - `detach` removes terminals from this window's store without killing PTYs.
 *
 * When this window is named as a transfer target it adopts the ids, then
 * acknowledges the request so only its waiting source releases them.
 */
export function installTransferReceiver(
  myLabel: string,
  adopt: (config: TerminalConfig, restoredOutput?: string) => void,
  detach: (ids: string[]) => void,
): () => void {
  // Track pending listen() promises AND resolved unlisten fns separately so a
  // cleanup that fires before listen() resolves can still cancel the pending
  // registration - see the same pattern in App.tsx's terminal-output listener.
  let cancelled = false;
  const unlisteners: Array<() => void> = [];
  const requests = new Map<string, { ids: string[]; cancelled: boolean }>();
  const remember = (requestId: string) => {
    const record = { ids: [] as string[], cancelled: false };
    requests.set(requestId, record);
    // Retain recent completions long enough to roll back late cancellations.
    if (requests.size > 128) requests.delete(requests.keys().next().value!);
    return record;
  };

  const track = (p: Promise<() => void>) => {
    p.then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    }).catch(() => {
      // listen() failing is a Tauri-side error; nothing to unlisten in that case.
    });
  };

  const cancellationReady = listen<{ targetLabel: string; requestId: string }>(CANCEL_EVENT, event => {
    if (event.payload.targetLabel !== myLabel) return;
    const record = requests.get(event.payload.requestId) ?? remember(event.payload.requestId);
    record.cancelled = true;
    if (record.ids.length) detach(record.ids);
    record.ids = [];
  });
  track(cancellationReady);
  track(
    cancellationReady.then(() => cancelled ? () => {} : listen<TransferPayload>(TRANSFER_EVENT, async (event) => {
      const { targetLabel, ids, sourceLabel, requestId, expiresAt } = event.payload;
      if (targetLabel !== myLabel || sourceLabel === myLabel || cancelled) return;
      if (requests.has(requestId)) return;
      const record = remember(requestId);
      const adopted = record.ids;
      try {
        const all = await invoke<TerminalConfig[]>('get_terminals');
        const byId = new Map(all.map(c => [c.id, c]));
        if (ids.some(id => !byId.has(id))) throw new Error('A transferred terminal is no longer available');
        const logs = await Promise.all(ids.map(id => invoke<string | null>('get_session_log', { terminalId: id }).catch(() => null)));
        if (cancelled || record.cancelled || Date.now() >= expiresAt) throw new Error('Tab transfer expired');
        for (let i = 0; i < ids.length; i++) {
          adopt(byId.get(ids[i])!, logs[i] ?? undefined);
          adopted.push(ids[i]);
        }
        await emit(TRANSFER_DONE_EVENT, { ids: adopted, byLabel: myLabel, requestId } as TransferDonePayload);
        await getCurrentWebviewWindow().setFocus().catch(() => {});
      } catch (err) {
        // A failed adoption/acknowledgement must leave ownership at the source.
        detach(adopted);
        reportError('tab_transfer_adopt', String(err));
        await emit(TRANSFER_DONE_EVENT, { ids: [], byLabel: myLabel, requestId, error: String(err) } as TransferDonePayload).catch(() => {});
      }
    })).then(fn => {
      if (!cancelled) void emit(READY_EVENT, { label: myLabel }).catch(() => {});
      return fn;
    }),
  );

  return () => {
    cancelled = true;
    for (const fn of unlisteners) fn();
  };
}
