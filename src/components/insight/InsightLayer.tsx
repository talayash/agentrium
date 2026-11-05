import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useInsightFeed, useInsightModel } from '../../hooks/useInsightFeed';
import { useInsightStore } from '../../store/insightStore';
import { useTerminalStore } from '../../store/terminalStore';
import { InsightCollapsedBar } from './InsightCollapsedBar';
import { QuestionBox } from './QuestionBox';
import { TurnDigest } from './TurnDigest';

const MIN_PX = 120;
const DEFAULT_FRACTION = 0.4;
const MAX_FRACTION = 0.7;
const SHORT_PANE_PX = 360;
const KEY_STEP_PX = 16;
const FALLBACK_PANE_PX = 600;

const clamp = (px: number, pane: number) =>
  Math.round(Math.min(Math.max(px, MIN_PX), Math.max(MIN_PX, pane * MAX_FRACTION)));

export function InsightLayer({ terminalId }: { terminalId: string }) {
  useInsightFeed(terminalId, true);
  const model = useInsightModel(terminalId);
  const state = useInsightStore((s) => s.byId.get(terminalId));
  const { setHeight, setCollapsed, setExpandedTurn } = useInsightStore.getState();

  const rootRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  // Drag preview only (a guide line); the real height is committed once on mouseup.
  const [dragPx, setDragPx] = useState<number | null>(null);

  // Measure the pane (the parent grid cell) before first paint so a short cell
  // is collapsed from the start (no expanded flash, no extra PTY resize).
  // A zero height means "not laid out", treated as unknown.
  useLayoutEffect(() => {
    const h = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
    if (h > 0) setPaneHeight(h);
  }, []);

  // Keep tracking the pane so later resizes still apply while the user has not chosen.
  useEffect(() => {
    const pane = rootRef.current?.parentElement;
    if (!pane || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry && entry.contentRect.height > 0) setPaneHeight(entry.contentRect.height);
    });
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  const pane = paneHeight ?? FALLBACK_PANE_PX;
  const collapsed = state?.collapsed ?? (paneHeight !== null && paneHeight < SHORT_PANE_PX);
  const panelPx = clamp(state?.heightPx ?? pane * DEFAULT_FRACTION, pane);
  const newest = model.turns[0];
  const older = model.turns.slice(1);
  const expandedTurn = state?.expandedTurn ?? null;

  // Window listeners must not outlive the layer if it unmounts mid-drag.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragCleanupRef.current?.();
    const startY = e.clientY;
    const startPx = panelPx;
    const target = (ev: MouseEvent) => clamp(startPx + ev.clientY - startY, pane);
    const move = (ev: MouseEvent) => setDragPx(target(ev));
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dragCleanupRef.current = null;
    };
    const up = (ev: MouseEvent) => {
      stop();
      setDragPx(null);
      setHeight(terminalId, target(ev));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    dragCleanupRef.current = stop;
  };

  const onSeparatorKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp') setHeight(terminalId, clamp(panelPx - KEY_STEP_PX, pane));
    else if (e.key === 'ArrowDown') setHeight(terminalId, clamp(panelPx + KEY_STEP_PX, pane));
    else return;
    e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') useTerminalStore.getState().terminals.get(terminalId)?.xterm?.focus();
  };

  if (collapsed) {
    return (
      <div ref={rootRef} onKeyDown={onKeyDown} className="shrink-0">
        <InsightCollapsedBar
          headline={newest?.headline ?? null}
          hasQuestion={model.pendingQuestion !== null}
          onExpand={() => setCollapsed(terminalId, false)}
        />
      </div>
    );
  }

  let body;
  if (state?.supported === false) {
    // Task 12 replaces this with the full fallback body.
    body = <div className="px-2 py-2 text-[11px] text-text-tertiary">Insight is not available for this session.</div>;
  } else if (!newest) {
    body = <div className="px-2 py-2 text-[11px] text-text-tertiary">Waiting for the session transcript...</div>;
  } else {
    body = (
      <>
        <TurnDigest terminalId={terminalId} turn={newest} />
        {older.map((t) =>
          expandedTurn === t.index ? (
            <div key={t.index} className="border-t border-seam">
              <button
                type="button"
                onClick={() => setExpandedTurn(terminalId, null)}
                className="flex w-full items-center gap-1 px-2 pt-1 text-left text-[11px] text-text-tertiary hover:text-text-primary"
              >
                <ChevronDown size={11} strokeWidth={1.75} />
                Turn {t.index}
              </button>
              <TurnDigest terminalId={terminalId} turn={t} />
            </div>
          ) : (
            <button
              key={t.index}
              type="button"
              onClick={() => setExpandedTurn(terminalId, t.index)}
              className="flex w-full items-center gap-1 border-t border-seam px-2 py-1 text-left text-[11px] text-text-secondary hover:text-text-primary"
            >
              <ChevronRight size={11} strokeWidth={1.75} className="shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate">{`Turn ${t.index}: ${t.headline}`}</span>
            </button>
          ),
        )}
      </>
    );
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative flex shrink-0 flex-col border-b border-seam bg-bg-primary">
      <div style={{ height: panelPx }} className="overflow-y-auto" data-testid="insight-body">
        <div className="flex items-center border-b border-seam">
          <button
            type="button"
            onClick={() => setCollapsed(terminalId, true)}
            aria-label="Collapse insight layer"
            className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide text-text-tertiary hover:text-text-primary"
          >
            <ChevronDown size={11} strokeWidth={1.75} />
            Insight
          </button>
        </div>
        {model.pendingQuestion && <QuestionBox terminalId={terminalId} pending={model.pendingQuestion} />}
        {body}
      </div>
      {dragPx !== null && (
        <div
          aria-hidden="true"
          data-testid="insight-drag-guide"
          style={{ top: dragPx }}
          className="pointer-events-none absolute left-0 right-0 z-10 h-0.5 bg-accent-primary/60"
        />
      )}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize insight layer"
        aria-valuenow={panelPx}
        aria-valuemin={MIN_PX}
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={onSeparatorKey}
        className="h-1.5 shrink-0 cursor-row-resize bg-seam hover:bg-accent-primary/40 focus:outline-none focus-visible:bg-accent-primary/60"
      />
    </div>
  );
}
