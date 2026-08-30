import { useEffect, useRef, useState, memo, useCallback, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { X, Maximize2, Minimize2, Plus, Grid3X3, Layers, Pin } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore, GridLayout } from '../store/appStore';
import { TerminalView } from './TerminalView';
import { setDragData, getDragData, isTerminalDrag } from '../utils/dragDrop';
import { computeGridNavTarget } from '../lib/gridNav';
import { computeEmptyCellCount } from '../lib/gridEmptyCells';
import { BrandIcon } from './BrandIcon';

// Grid layout configurations
const GRID_CONFIGS: Record<GridLayout, { cols: number; rows: number }> = {
  '1x1': { cols: 1, rows: 1 },
  '1x2': { cols: 2, rows: 1 },
  '2x1': { cols: 1, rows: 2 },
  '2x2': { cols: 2, rows: 2 },
  '1x3': { cols: 3, rows: 1 },
  '3x1': { cols: 1, rows: 3 },
  '2x3': { cols: 3, rows: 2 },
  '3x2': { cols: 2, rows: 3 },
  '2x4': { cols: 4, rows: 2 },
  '4x2': { cols: 2, rows: 4 },
};

/**
 * A miniature schematic of the actual grid layout, so the picker's icon
 * always matches the layout it applies. Replaces the earlier scheme where
 * '2x2' rendered a 3x3 lucide icon and '2x3'/'2x4' shared the same icon.
 */
function LayoutIcon({ rows, cols, size = 14 }: { rows: number; cols: number; size?: number }) {
  const cellW = 24 / cols;
  const cellH = 24 / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={c * cellW + 1.5}
          y={r * cellH + 1.5}
          width={cellW - 3}
          height={cellH - 3}
          rx="1"
          fill="currentColor"
        />
      );
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {cells}
    </svg>
  );
}

const LAYOUT_OPTIONS: { layout: GridLayout; label: string }[] = [
  { layout: '1x1', label: 'Single' },
  { layout: '1x2', label: '2 Columns' },
  { layout: '2x1', label: '2 Rows' },
  { layout: '2x2', label: '2x2 Grid' },
  { layout: '2x3', label: '2x3 Grid' },
  { layout: '2x4', label: '2x4 Grid' },
];

interface TerminalCellProps {
  terminalId: string;
  index: number;
  isFocused: boolean;
  onFocus: () => void;
  onRemove: () => void;
  onMaximize: () => void;
}

const TerminalCell = memo(function TerminalCell({ terminalId, index, isFocused, onFocus, onRemove, onMaximize }: TerminalCellProps) {
  const { terminals } = useTerminalStore();
  const { swapGridPositions, replaceInGrid, removeFromGrid } = useAppStore();
  const pinnedTabIds = useAppStore((s) => s.pinnedTabIds);
  const isPinned = pinnedTabIds.includes(terminalId);
  const [dropOver, setDropOver] = useState(false);
  const terminal = terminals.get(terminalId);

  // Grid cells hold onto ids that may become stale: a right-click restart
  // gives a terminal a new id, and app restart repopulates terminals with
  // fresh ids. Auto-prune those stale entries once the terminals map has
  // actually been populated (guards against pruning during first mount
  // before session restore lands). Without this, cells rendered forever
  // as "Terminal not found".
  useEffect(() => {
    if (!terminal && terminals.size > 0) {
      removeFromGrid(terminalId);
    }
  }, [terminal, terminals.size, terminalId, removeFromGrid]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isTerminalDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (isTerminalDrag(e)) {
      e.preventDefault();
      setDropOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the cell entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropOver(false);
    const payload = getDragData(e);
    if (!payload || payload.terminalId === terminalId) return;

    if (payload.source === 'grid' && payload.sourceIndex !== undefined) {
      swapGridPositions(payload.sourceIndex, index);
    } else {
      replaceInGrid(index, payload.terminalId);
    }
  }, [terminalId, index, swapGridPositions, replaceInGrid]);

  if (!terminal) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-secondary border border-border rounded-md">
        <p className="text-text-tertiary text-[12px]">Terminal not found</p>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        setDragData(e, { terminalId, source: 'grid', sourceIndex: index });
      }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative h-full flex flex-col rounded-md overflow-hidden transition-all ${
        dropOver
          ? 'ring-2 ring-accent-primary bg-accent-primary/5'
          : isFocused
            ? 'ring-2 ring-accent-primary shadow-glow-md'
            : 'ring-1 ring-border hover:ring-border-light hover:shadow-elevation-2'
      }`}
      onClick={onFocus}
    >
      {/* Drop overlay */}
      {dropOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-accent-primary/10 border-2 border-dashed border-accent-primary/40 rounded pointer-events-none">
          <span className="text-accent-primary text-[11px] font-medium">Drop to swap</span>
        </div>
      )}

      {/* Cell Header - sketch: pin + name + status dot + maximize + close */}
      <div className={`flex items-center justify-between px-3 h-7 border-b gap-2 ${
        isFocused ? 'bg-accent-primary/10 border-accent-primary/40' : 'bg-bg-secondary border-border'
      }`}>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {isPinned && (
            <Pin size={10} strokeWidth={2} className="text-accent-primary flex-shrink-0" />
          )}
          <span className="opacity-70 flex-shrink-0 flex items-center" title={`Agent: ${terminal.config.agent}`}>
            <BrandIcon kind={terminal.config.agent} size={12} />
          </span>
          <span className={`text-[11px] truncate font-medium cursor-grab ${
            isFocused ? 'text-text-primary' : 'text-text-secondary'
          }`}>
            {terminal.config.nickname || terminal.config.label}
          </span>
          {/* Status dot - pulses when running (matches sketch's cell head) */}
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              terminal.config.status === 'Running'
                ? 'bg-success ct-working-dot'
                : terminal.config.status === 'Idle'
                ? 'bg-warning'
                : terminal.config.status === 'Error'
                ? 'bg-error'
                : 'bg-text-tertiary'
            }`}
            title={terminal.config.status}
          />
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMaximize();
            }}
            className="p-0.5 rounded hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors"
            title="Maximize"
          >
            <Maximize2 size={10} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="p-0.5 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 transition-colors"
            title="Remove from grid"
          >
            <X size={10} />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 overflow-hidden">
        <TerminalView terminalId={terminalId} />
      </div>
    </div>
  );
});

function AddTerminalCell() {
  const { terminals } = useTerminalStore();
  const { gridTerminalIds, openNewTerminalModal, addToGrid } = useAppStore();
  const [showPicker, setShowPicker] = useState(false);
  const [dropOver, setDropOver] = useState(false);

  const availableTerminals = useMemo(() =>
    Array.from(terminals.values())
      .filter(t => !gridTerminalIds.includes(t.config.id)),
    [terminals, gridTerminalIds]
  );

  return (
    <div
      className={`h-full flex flex-col items-center justify-center bg-elevation-0 rounded-xl transition-all cursor-pointer group relative ${
        dropOver
          ? 'ring-2 ring-accent-primary bg-accent-primary/5'
          : 'ring-1 ring-seam hover:ring-seam-strong hover:shadow-elevation-2'
      }`}
      onClick={() => setShowPicker(true)}
      onDragOver={(e) => {
        if (isTerminalDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDragEnter={(e) => {
        if (isTerminalDrag(e)) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDropOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        const payload = getDragData(e);
        if (payload && !gridTerminalIds.includes(payload.terminalId)) {
          addToGrid(payload.terminalId);
        }
      }}
    >
      {dropOver ? (
        <span className="text-accent-primary text-[11px] font-medium">Drop here</span>
      ) : (
        <Plus size={24} className="text-border-light group-hover:text-text-tertiary transition-colors" />
      )}

      {/* Terminal Picker Dropdown */}
      <AnimatePresence>
        {showPicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setShowPicker(false);
              }}
            />
            <div
              className="absolute z-50 material-popover rounded-lg p-2 min-w-[200px]"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-text-tertiary text-[11px] px-2 py-1 mb-1">Select Terminal</p>
              {availableTerminals.length > 0 ? (
                <div className="max-h-48 overflow-y-auto space-y-0.5">
                  {availableTerminals.map((t) => (
                    <button
                      key={t.config.id}
                      onClick={() => {
                        addToGrid(t.config.id);
                        setShowPicker(false);
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-fill-hover text-left"
                    >
                      <span className="opacity-70 flex-shrink-0 flex items-center">
                        <BrandIcon kind={t.config.agent} size={12} />
                      </span>
                      <span className="text-text-primary text-[12px] truncate">
                        {t.config.nickname || t.config.label}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-text-tertiary text-[11px] px-2 py-2">No available terminals</p>
              )}
              <div className="border-t border-border mt-2 pt-2">
                <button
                  onClick={() => {
                    openNewTerminalModal();
                    setShowPicker(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent-primary/10 text-accent-primary text-[12px]"
                >
                  <Plus size={14} />
                  Create New Terminal
                </button>
              </div>
            </div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TerminalGrid() {
  const {
    gridTerminalIds,
    gridLayout,
    gridFocusedIndex,
    setGridFocusedIndex,
    removeFromGrid,
    setGridLayout,
    setGridMode,
    setGridTerminals,
    openNewTerminalModal,
  } = useAppStore();
  const { terminals, setActiveTerminal } = useTerminalStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const allTerminalIds = useMemo(() => Array.from(terminals.keys()), [terminals]);
  const canAddAll = allTerminalIds.length > 0 && (
    allTerminalIds.length !== gridTerminalIds.length ||
    allTerminalIds.some((id, i) => gridTerminalIds[i] !== id)
  );

  const handleAddAll = useCallback(() => {
    setGridTerminals(allTerminalIds);
  }, [allTerminalIds, setGridTerminals]);

  const config = GRID_CONFIGS[gridLayout];
  const emptyCells = computeEmptyCellCount({
    layoutCols: config.cols,
    layoutRows: config.rows,
    filledCount: gridTerminalIds.length,
  });

  // Move real keyboard focus to a pane's terminal so the user can type right
  // after navigating, without clicking.
  const focusPaneTerminal = useCallback((id: string | undefined) => {
    if (!id) return;
    requestAnimationFrame(() => {
      useTerminalStore.getState().terminals.get(id)?.xterm?.focus();
    });
  }, []);

  // Spatial pane navigation, gated behind Alt. The old handler hijacked BARE
  // arrow keys whenever a pane was focused, so they were double-handled - the
  // PTY received them (shell history / cursor / vim) AND the grid moved focus.
  // Alt frees bare arrows for the terminal; capture phase + stopImmediate-
  // Propagation keep Alt+Arrow / Alt+1-8 from also reaching xterm.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ids = gridTerminalIds;
      const target = computeGridNavTarget(e, gridFocusedIndex, config.cols, ids.length);
      if (target === null) return; // not ours - pass through to the focused terminal

      // Consume so Alt+Arrow / Alt+1-8 never also reach xterm.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (target !== gridFocusedIndex) {
        setGridFocusedIndex(target);
        focusPaneTerminal(ids[target]);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [gridFocusedIndex, config, gridTerminalIds, setGridFocusedIndex, focusPaneTerminal]);

  const handleMaximize = useCallback((terminalId: string) => {
    setActiveTerminal(terminalId);
    setGridMode(false);
  }, [setActiveTerminal, setGridMode]);

  return (
    <div className="h-full flex flex-col">
      {/* Grid Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
        <div className="flex items-center gap-2">
          <Grid3X3 size={14} className="text-text-secondary" />
          <span className="text-text-primary text-[12px] font-medium">Grid View</span>
          <span className="text-text-tertiary text-[11px]">
            ({gridTerminalIds.length}/8)
          </span>
          {gridTerminalIds.length > 1 && (
            <span className="text-text-tertiary text-[11px]">· Alt+Arrows / Alt+1-8 to navigate</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Layout Selector */}
          <div className="flex items-center gap-0.5 bg-bg-primary rounded-md p-0.5">
            {LAYOUT_OPTIONS.map((option) => {
              const cfg = GRID_CONFIGS[option.layout];
              return (
                <button
                  key={option.layout}
                  onClick={() => setGridLayout(option.layout)}
                  className={`p-1 rounded transition-colors ${
                    gridLayout === option.layout
                      ? 'bg-accent-primary text-white'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-fill-hover'
                  }`}
                  title={option.label}
                >
                  <LayoutIcon rows={cfg.rows} cols={cfg.cols} />
                </button>
              );
            })}
          </div>

          {/* New Terminal Button */}
          <button
            onClick={() => openNewTerminalModal()}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-fill-hover rounded transition-colors"
            title="Create a new terminal in the grid"
          >
            <Plus size={12} />
            New Terminal
          </button>

          {/* Add All Terminals Button */}
          <button
            onClick={handleAddAll}
            disabled={!canAddAll}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-fill-hover rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
            title={
              allTerminalIds.length === 0
                ? 'No active terminals'
                : allTerminalIds.length > 8
                  ? `Add first 8 of ${allTerminalIds.length} terminals to grid`
                  : `Add all ${allTerminalIds.length} terminals to grid`
            }
          >
            <Layers size={12} />
            Add All
          </button>

          {/* Exit Grid Mode */}
          <button
            onClick={() => setGridMode(false)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-fill-hover rounded transition-colors"
          >
            <Minimize2 size={12} />
            Exit Grid
          </button>
        </div>
      </div>

      {/* Grid Container */}
      <div
        ref={containerRef}
        className="flex-1 p-1 overflow-hidden"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${config.cols}, 1fr)`,
          gridTemplateRows: `repeat(${config.rows}, 1fr)`,
          gap: '4px',
        }}
      >
        <AnimatePresence mode="popLayout">
          {/* Filled terminal cells */}
          {gridTerminalIds.map((terminalId, index) => (
            <TerminalCell
              key={terminalId}
              terminalId={terminalId}
              index={index}
              isFocused={gridFocusedIndex === index}
              onFocus={() => setGridFocusedIndex(index)}
              onRemove={() => removeFromGrid(terminalId)}
              onMaximize={() => handleMaximize(terminalId)}
            />
          ))}

          {/* Empty cells for adding more terminals */}
          {Array.from({ length: emptyCells }).map((_, index) => (
            <AddTerminalCell key={`empty-${index}`} />
          ))}
        </AnimatePresence>
      </div>

      {/* Empty State */}
      {gridTerminalIds.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-xl bg-fill-hover ring-1 ring-seam flex items-center justify-center">
              <Grid3X3 size={28} className="text-text-tertiary" />
            </div>
            <div className="space-y-1">
              <p className="text-text-secondary text-[13px] font-medium">No terminals in grid</p>
              <p className="text-text-tertiary text-[12px]">Click any <Plus size={12} className="inline -mt-0.5" /> cell to add a terminal</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
