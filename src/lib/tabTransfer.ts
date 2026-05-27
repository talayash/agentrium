import { invoke } from '@tauri-apps/api/core';
import {
  WebviewWindow,
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';
import type { TerminalConfig } from '../store/terminalStore';

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
    title: 'ClaudeTerminal',
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
  });
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
  let overSource = false;
  const windows = await getAllWebviewWindows();
  for (const w of windows) {
    try {
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      const inside =
        cx >= pos.x && cx <= pos.x + size.width && cy >= pos.y && cy <= pos.y + size.height;
      if (!inside) continue;
      if (w.label === sourceLabel) {
        overSource = true;
      } else {
        target = w.label;
        break; // a non-source window wins
      }
    } catch {
      // Window may have closed mid-drag — skip it.
    }
  }

  if (target) {
    await emit(TRANSFER_EVENT, { targetLabel: target, ids, sourceLabel } as TransferPayload);
  } else if (!overSource) {
    await createDetachedWindow(ids, cx, cy);
  }
  // overSource && !target → dropped on the source window's own body; do nothing.
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
        console.error('[tabTransfer] adopt failed:', err);
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
