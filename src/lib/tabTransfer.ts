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

interface TransferPayload {
  targetLabel: string;
  ids: string[];
  sourceLabel: string;
}
interface TransferDonePayload {
  ids: string[];
  byLabel: string;
}

/**
 * Create a new torn-off window at a physical screen position, carrying the
 * given terminal ids (which it adopts on boot). The PTYs are untouched — only a
 * new view is opened.
 */
export async function createDetachedWindow(ids: string[], physX: number, physY: number): Promise<void> {
  if (ids.length === 0) return;
  const label = `detached-${crypto.randomUUID()}`;
  const idsParam = encodeURIComponent(ids.join(','));

  const win = new WebviewWindow(label, {
    url: `index.html?mode=detached&ids=${idsParam}`,
    width: 1000,
    height: 680,
    minWidth: 480,
    minHeight: 320,
    decorations: false,
    transparent: true,
    title: 'ADE-1',
  });

  win.once('tauri://created', () => {
    // Cursor position is physical; window-option x/y are logical, so set the
    // position explicitly in physical pixels after creation, then focus.
    win
      .setPosition(new PhysicalPosition(Math.round(physX), Math.round(physY)))
      .then(() => win.setFocus())
      .catch(() => {
        /* positioning is best-effort */
      });
  });
  win.once('tauri://error', (e) => {
    console.error('[tabTransfer] failed to create detached window:', e);
    // Window creation is Tauri-internal (not a wrapped command), so nothing
    // else reports it - and the user is left with a tab that went nowhere.
    reportError('window_create', `tear-off window failed: ${JSON.stringify(e.payload ?? e)}`);
  });
}

/**
 * Recreate a detached window on startup at its saved geometry and hand it the
 * given (already-restored) terminal ids, detaching them from the main window.
 * Mirrors a tear-off but driven by the persisted layout instead of a drag.
 */
export async function restoreDetachedWindow(ids: string[], geometry?: WindowGeometry): Promise<void> {
  if (ids.length === 0) return;
  const label = `detached-${crypto.randomUUID()}`;
  const idsParam = encodeURIComponent(ids.join(','));

  const win = new WebviewWindow(label, {
    url: `index.html?mode=detached&ids=${idsParam}`,
    width: 1000,
    height: 680,
    minWidth: 480,
    minHeight: 320,
    decorations: false,
    transparent: true,
    title: 'ADE-1',
  });

  win.once('tauri://created', () => {
    if (geometry) {
      win
        .setPosition(new PhysicalPosition(Math.round(geometry.x), Math.round(geometry.y)))
        .then(() => win.setSize(new PhysicalSize(Math.round(geometry.w), Math.round(geometry.h))))
        .catch(() => {
          /* geometry restore is best-effort */
        });
    }
  });
  win.once('tauri://error', (e) => {
    console.error('[tabTransfer] failed to restore detached window:', e);
    reportError('window_create', `detached-window restore failed: ${JSON.stringify(e.payload ?? e)}`);
  });

  // The new window adopts these ids on load; remove them from main now.
  useTerminalStore.getState().detachTerminals(ids);
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
      // Window may have closed mid-drag — skip it.
    }
  }

  if (target) {
    // Dropped over another window → transfer the tab(s) there.
    await emit(TRANSFER_EVENT, { targetLabel: target, ids, sourceLabel } as TransferPayload);
  } else {
    // Dropped over the source window's own body, or empty desktop → tear off a
    // new window at the cursor. (Drops over the source's tab strip are handled
    // as a reorder before routeTabDrop is ever called.)
    await createDetachedWindow(ids, cx, cy);
  }

  // Remove the tab(s) from the SOURCE window immediately so they don't linger
  // there while the destination renders them. The PTYs stay alive in the
  // backend — the new/target window adopts them independently (and the DONE
  // event from a transfer makes this a harmless no-op if it lands again).
  useTerminalStore.getState().detachTerminals(ids);
}

/**
 * Explicitly request that `targetLabel` adopt the given ids (e.g. a detached
 * window returning its tabs to 'main' when it closes). The target's receiver
 * adopts them and broadcasts the "done" that releases them from this window.
 */
export async function requestTransfer(targetLabel: string, ids: string[], sourceLabel: string): Promise<void> {
  if (ids.length === 0) return;
  await emit(TRANSFER_EVENT, { targetLabel, ids, sourceLabel } as TransferPayload);
}

/**
 * Wire a window into the transfer protocol. Returns an unlisten function.
 *   - `adopt`  registers a terminal whose PTY already exists (seeds scrollback).
 *   - `detach` removes terminals from this window's store without killing PTYs.
 *
 * When this window is named as a transfer target it adopts the ids, then
 * broadcasts a "done" so the source window releases them. Events broadcast to
 * all windows; non-owners' detach calls are harmless no-ops.
 */
export function installTransferReceiver(
  myLabel: string,
  adopt: (config: TerminalConfig, restoredOutput?: string) => void,
  detach: (ids: string[]) => void,
): () => void {
  const pending: Array<Promise<() => void>> = [];

  pending.push(
    listen<TransferPayload>(TRANSFER_EVENT, async (event) => {
      const { targetLabel, ids, sourceLabel } = event.payload;
      if (targetLabel !== myLabel || sourceLabel === myLabel) return;
      try {
        const all = await invoke<TerminalConfig[]>('get_terminals');
        const byId = new Map(all.map((c) => [c.id, c]));
        for (const id of ids) {
          const cfg = byId.get(id);
          if (!cfg) continue;
          let log: string | undefined;
          try {
            log = (await invoke<string | null>('get_session_log', { terminalId: id })) ?? undefined;
          } catch {
            /* no log — adopt without scrollback */
          }
          adopt(cfg, log);
        }
        await emit(TRANSFER_DONE_EVENT, { ids, byLabel: myLabel } as TransferDonePayload);
        try {
          await getCurrentWebviewWindow().setFocus();
        } catch {
          /* focus is best-effort */
        }
      } catch (err) {
        reportError('tab_transfer_adopt', err instanceof Error ? err.message : String(err));
      }
    }),
  );

  pending.push(
    listen<TransferDonePayload>(TRANSFER_DONE_EVENT, (event) => {
      const { ids, byLabel } = event.payload;
      if (byLabel === myLabel) return; // I'm the adopter; keep them
      detach(ids);
    }),
  );

  return () => {
    pending.forEach((p) => p.then((fn) => fn()).catch(() => {}));
  };
}
