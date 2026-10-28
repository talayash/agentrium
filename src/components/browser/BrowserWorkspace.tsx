import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useBrowserStore, clampSplit } from '../../store/browserStore';
import { BrowserView } from './BrowserView';

/**
 * Main card content: the terminals alone, the browser alone, or both side by
 * side with a draggable divider. Terminals stay mounted (and keep their size,
 * so xterm never refits to zero) while the browser covers them.
 */
export function BrowserWorkspace({ children }: { children: ReactNode }) {
  const open = useBrowserStore((s) => s.open);
  const layout = useBrowserStore((s) => s.layout);
  const splitPx = useBrowserStore((s) => s.splitPx);
  const setSplitPx = useBrowserStore((s) => s.setSplitPx);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerPx, setContainerPx] = useState(0);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerPx(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const split = open && layout === 'split';
  const covered = open && !split;
  const terminalPx = containerPx ? clampSplit(splitPx, containerPx) : splitPx;

  // Covered terminals must not keep keyboard focus or be tabbable.
  const terminalsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = terminalsRef.current;
    if (!el) return;
    el.inert = covered;
    if (covered && el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [covered]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, width: terminalPx };
    // Hides the native page (see BrowserView) so it can't swallow the drag.
    setResizing(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    setSplitPx(start.width + (e.clientX - start.x), containerPx);
  };
  const endDrag = () => {
    dragRef.current = null;
    setResizing(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === 'ArrowLeft') setSplitPx(terminalPx - step, containerPx);
    else if (e.key === 'ArrowRight') setSplitPx(terminalPx + step, containerPx);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0 flex">
      {/* Full-width browser covers the terminals instead of re-laying them
          out, so their PTYs are never resized just by opening the browser. */}
      <div
        ref={terminalsRef}
        className={split ? 'shrink-0 min-w-0 h-full' : 'flex-1 min-w-0 h-full'}
        style={split ? { width: terminalPx } : undefined}
        aria-hidden={covered || undefined}
      >
        {children}
      </div>

      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal and browser"
          aria-valuenow={terminalPx}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="group w-[7px] shrink-0 flex justify-center cursor-col-resize touch-none outline-none"
          data-testid="browser-split-handle"
        >
          <div
            className={`w-0.5 h-full transition-colors ${
              resizing
                ? 'bg-accent-primary'
                : 'bg-seam-strong group-hover:bg-accent-primary/50 group-focus-visible:bg-accent-primary'
            }`}
          />
        </div>
      )}

      {open && (
        <div className={split ? 'relative flex-1 min-w-0' : 'absolute left-0 top-0 w-full h-full z-10'}>
          <BrowserView resizing={resizing} />
          {resizing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center cursor-col-resize">
              <span className="px-3 py-1.5 rounded-lg bg-elevation-4 text-[12px] font-mono text-text-primary">
                {terminalPx} px | {Math.max(0, Math.round(containerPx - terminalPx - 7))} px
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
