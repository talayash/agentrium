import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { useAppStore } from '../store/appStore';
import {
  applyAccentColor,
  applyThemeMode,
  applyDensity,
  applyReduceMotion,
  applyUiFontScale,
} from '../lib/accentTheme';

interface PreviewMeta {
  label: string;
  color: string | null;
  count: number;
  width: number;
}

export const DRAG_PREVIEW_START = 'ct://drag-preview:start';
export const DRAG_PREVIEW_END = 'ct://drag-preview:end';

/**
 * A transparent, always-on-top, click-through overlay window that renders just
 * the "lifted tab" and follows the global cursor — so the dragged tab is
 * visible even outside the source window (a DOM ghost is clipped to its window;
 * this isn't). The main window pre-creates it hidden at startup; tab drags emit
 * start/end events to show/hide it. It self-positions by polling the global
 * cursor (the source window stops getting pointer events once the cursor leaves
 * it, so the overlay must drive its own position).
 */
export function DragPreview() {
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const runningRef = useRef(false);

  // The overlay boots the full bundle; apply the persisted appearance so the
  // tab matches the app's theme/accent.
  useEffect(() => {
    const s = useAppStore.getState();
    applyThemeMode(s.themeMode);
    applyDensity(s.uiDensity);
    applyAccentColor(s.accentColorHex);
    applyReduceMotion(s.uiReduceMotion);
    applyUiFontScale(s.uiFontScale);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    // Never intercept the pointer — the drop must hit the window/desktop below.
    win.setIgnoreCursorEvents(true).catch(() => {});
    win.setAlwaysOnTop(true).catch(() => {});

    const follow = async () => {
      if (!runningRef.current) return;
      try {
        const [cx, cy] = await invoke<[number, number]>('get_cursor_position');
        await win.setPosition(new PhysicalPosition(Math.round(cx + 14), Math.round(cy + 16)));
      } catch {
        /* transient — keep going */
      }
      if (runningRef.current) requestAnimationFrame(follow);
    };

    const unStart = listen<PreviewMeta>(DRAG_PREVIEW_START, async (e) => {
      setMeta(e.payload);
      try {
        await win.setSize(new LogicalSize(Math.max(80, e.payload.width) + 48, 64));
        await win.show();
      } catch {
        /* ignore */
      }
      if (!runningRef.current) {
        runningRef.current = true;
        requestAnimationFrame(follow);
      }
    });

    const unEnd = listen(DRAG_PREVIEW_END, async () => {
      runningRef.current = false;
      setMeta(null);
      try {
        await win.hide();
      } catch {
        /* ignore */
      }
    });

    return () => {
      runningRef.current = false;
      unStart.then((fn) => fn());
      unEnd.then((fn) => fn());
    };
  }, []);

  return (
    <div className="h-screen w-screen flex items-center justify-center overflow-hidden bg-transparent">
      {meta && (
        <div
          style={{
            transform: 'rotate(-3deg) scale(1.05)',
            boxShadow: '0 12px 30px rgba(0,0,0,0.5), 0 3px 10px rgba(0,0,0,0.4)',
            width: meta.width || undefined,
          }}
          className="h-9 px-3 flex items-center gap-2 rounded-md bg-elevation-0 ring-1 ring-accent-primary/70 text-[12px] text-text-primary select-none overflow-hidden ct-ghost"
        >
          {meta.color && <div className={`w-2 h-2 rounded-full ${meta.color} flex-shrink-0`} />}
          <span className="truncate">{meta.label}</span>
          {meta.count > 1 && (
            <span className="text-[10px] px-1 rounded bg-accent-primary/20 text-accent-primary flex-shrink-0">
              +{meta.count - 1}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
