import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';
import { PreviewToolbar } from './PreviewToolbar';

export function PreviewPanel() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const panelWidthPx = usePreviewStore((s) => s.panelWidthPx);
  const setPanelWidth = usePreviewStore((s) => s.setPanelWidth);
  const allowList = usePreviewStore((s) => s.allowList);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const resolveUrl = usePreviewStore((s) => s.resolveUrl);
  const keepAliveAcrossTabs = usePreviewStore((s) => s.keepAliveAcrossTabs);

  const url = activeId ? resolveUrl(activeId) : null;
  const state = activeId ? perTerminal.get(activeId) : undefined;
  const reloadCounter = state?.reloadCounter ?? 0;

  const allowed = useMemo(
    () => (url ? isUrlAllowed(url, allowList) : false),
    [url, allowList],
  );

  const keepAliveEntries = useMemo(() => {
    if (!keepAliveAcrossTabs) return [] as Array<{ id: string; url: string; reloadCounter: number }>;
    const out: Array<{ id: string; url: string; reloadCounter: number }> = [];
    for (const [id, s] of perTerminal) {
      const u = s.userOverride ?? s.detectedUrl;
      if (u && isUrlAllowed(u, allowList)) {
        out.push({ id, url: u, reloadCounter: s.reloadCounter });
      }
    }
    return out;
  }, [keepAliveAcrossTabs, perTerminal, allowList]);

  // Drag-to-resize: the panel sits on the RIGHT of the window, so the resize
  // handle lives on its LEFT edge. Dragging left widens the panel, dragging
  // right shrinks it. Deltas are computed from the pointer's initial x, so a
  // fast drag can't drift out of sync with the stored width.
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, width: panelWidthPx };
    setIsResizing(true);
  }, [panelWidthPx]);

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      // Left-edge handle on a right-docked panel: negative Δx = wider panel.
      setPanelWidth(start.width + (start.x - e.clientX));
    };
    const onUp = () => {
      dragStartRef.current = null;
      setIsResizing(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizing, setPanelWidth]);

  if (!globalOpen || !activeId) return null;

  return (
    <div
      className="h-full flex bg-bg-secondary border-l border-white/[0.06] overflow-hidden relative"
      style={{ width: panelWidthPx }}
      data-testid="preview-panel"
    >
      {/* Resize handle — 4px wide invisible strip on the left edge, with a
          hover state that reveals a hairline in the accent colour. */}
      <div
        onMouseDown={onHandleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        title="Drag to resize"
        className={`absolute left-0 top-0 bottom-0 w-1 z-10 cursor-col-resize
          hover:bg-accent-primary/50 active:bg-accent-primary
          ${isResizing ? 'bg-accent-primary' : 'bg-transparent'}
          transition-colors`}
        data-testid="preview-resize-handle"
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <PreviewToolbar terminalId={activeId} url={url} allowed={allowed} />

        <div className="flex-1 relative bg-black">
          {!url && (
            <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-[12px]">
              Waiting for a dev-server URL…
            </div>
          )}
          {url && !allowed && (
            <div className="absolute inset-0 flex items-center justify-center text-center p-6">
              <div className="max-w-sm">
                <div className="text-text-primary text-[13px] font-semibold mb-1">
                  URL not allowed
                </div>
                <div className="text-text-tertiary text-[11.5px]">
                  <code className="text-text-secondary">{url}</code> is outside the preview allow-list.
                  Add it in Settings → Preview.
                </div>
              </div>
            </div>
          )}
          {url && allowed && !keepAliveAcrossTabs && (
            <iframe
              key={`${url}#${reloadCounter}`}
              src={url}
              title="Preview"
              className="absolute inset-0 w-full h-full border-0"
            />
          )}
          {url && allowed && keepAliveAcrossTabs && keepAliveEntries.map(({ id, url: entryUrl, reloadCounter: rc }) => {
            const isActive = id === activeId;
            return (
              <iframe
                key={`${id}:${entryUrl}#${rc}`}
                src={entryUrl}
                title={`Preview (${id})`}
                className="absolute inset-0 w-full h-full border-0"
                style={{
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                }}
              />
            );
          })}

          {/* While dragging, an invisible overlay swallows pointer events so
              the mouse doesn't get "captured" by the iframe below (iframes
              are separate documents and would interrupt the mousemove). */}
          {isResizing && (
            <div
              className="absolute inset-0 z-20 cursor-col-resize"
              data-testid="preview-drag-shield"
            />
          )}
        </div>
      </div>
    </div>
  );
}
