import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, ToggleLeft, ToggleRight, Check, X } from 'lucide-react';
import { parseDiff, type DiffHunk } from '../utils/diffParser';
import { useHunkUndoStore } from '../store/hunkUndoStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface FileDiffResult {
  file_path: string;
  diff_text: string;
  is_new_file: boolean;
  is_deleted_file: boolean;
  is_binary: boolean;
}

interface InlineDiffViewProps {
  repoPath: string;
  filePath: string;
  terminalId: string;
  pathOverride?: string | null;
}

const MAX_DIFF_SIZE = 100_000; // 100KB guard
const HUNK_CONFIRM_THRESHOLD = 20;

function netChangeCount(hunk: DiffHunk): number {
  return hunk.lines.filter((l) => l.type === 'added' || l.type === 'removed').length;
}

function reconstructHunkPatch(hunk: DiffHunk): string {
  const lineStrings = hunk.lines.map((l) => {
    const prefix = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
    return prefix + l.content;
  });
  return hunk.header + '\n' + lineStrings.join('\n') + '\n';
}

export function InlineDiffView({ repoPath, filePath, terminalId, pathOverride }: InlineDiffViewProps) {
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [isBinary, setIsBinary] = useState(false);
  const [isNewFile, setIsNewFile] = useState(false);
  const [isDeletedFile, setIsDeletedFile] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [confirmingHunkIndex, setConfirmingHunkIndex] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushUndo = useHunkUndoStore((s) => s.push);

  const clearConfirmTimer = () => {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  };

  const fetchDiff = async (showStaged: boolean) => {
    setLoading(true);
    setError(null);
    setTruncated(false);
    setConfirmingHunkIndex(null);
    clearConfirmTimer();
    try {
      const result = pathOverride
        ? await invoke<FileDiffResult>('get_path_file_diff', {
            path: pathOverride,
            filePath,
            staged: showStaged,
          })
        : await invoke<FileDiffResult>('get_file_diff', {
            id: terminalId,
            filePath,
            staged: showStaged,
          });

      setIsNewFile(result.is_new_file);
      setIsDeletedFile(result.is_deleted_file);

      if (result.is_binary) {
        setIsBinary(true);
        setHunks([]);
      } else if (result.diff_text.length > MAX_DIFF_SIZE) {
        setTruncated(true);
        setHunks(parseDiff(result.diff_text.slice(0, MAX_DIFF_SIZE)));
      } else if (!result.diff_text.trim()) {
        setHunks([]);
        setError('No changes to display');
      } else {
        setHunks(parseDiff(result.diff_text));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      clearConfirmTimer();
    };
  }, []);

  useEffect(() => {
    fetchDiff(staged);
  }, [filePath, terminalId, pathOverride, staged]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={14} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="px-3 py-2">
        <p className="text-text-tertiary text-[11px] italic">Binary file - cannot display diff</p>
      </div>
    );
  }

  if (error && hunks.length === 0) {
    return (
      <div className="px-3 py-2">
        <p className="text-text-tertiary text-[11px] italic">{error}</p>
      </div>
    );
  }

  const lineNumberWidth = hunks.reduce((max, hunk) => {
    for (const line of hunk.lines) {
      const n = Math.max(line.oldLineNumber ?? 0, line.newLineNumber ?? 0);
      if (n > max) max = n;
    }
    return max;
  }, 0);
  const numWidth = Math.max(String(lineNumberWidth).length, 2);

  return (
    <div className="border-t border-border/50 bg-bg-primary/60">
      {/* Staged toggle */}
      <div className="flex items-center justify-end px-2 py-1 border-b border-border/30">
        <button
          onClick={() => setStaged(!staged)}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {staged ? <ToggleRight size={12} className="text-accent-primary" /> : <ToggleLeft size={12} />}
          <span>{staged ? 'Staged' : 'Unstaged'}</span>
        </button>
      </div>

      {/* Diff content */}
      <div className="max-h-[300px] overflow-y-auto overflow-x-auto">
        {hunks.map((hunk, hunkIdx) => {
          const showHunkActions = !staged && !isBinary && !isNewFile && !isDeletedFile;
          const isConfirming = confirmingHunkIndex === hunkIdx;

          const handleStageHunk = async () => {
            const hunkPatch = reconstructHunkPatch(hunk);
            try {
              await invoke('apply_hunk', { mode: 'stage', repoPath, filePath, hunkPatch });
              pushUndo({ kind: 'stage', repoPath, filePath, hunkPatch, atLine: hunkIdx, timestamp: Date.now() });
            } catch (err) {
              reportInvokeFailure('apply_hunk', err);
            }
          };

          const handleDiscardHunk = async () => {
            const hunkPatch = reconstructHunkPatch(hunk);
            try {
              await invoke('apply_hunk', { mode: 'discard', repoPath, filePath, hunkPatch });
              pushUndo({ kind: 'discard', repoPath, filePath, hunkPatch, atLine: hunkIdx, timestamp: Date.now() });
            } catch (err) {
              reportInvokeFailure('apply_hunk', err);
            }
          };

          const handleDiscardClick = () => {
            const count = netChangeCount(hunk);
            if (count <= HUNK_CONFIRM_THRESHOLD) {
              void handleDiscardHunk();
            } else {
              setConfirmingHunkIndex(hunkIdx);
              clearConfirmTimer();
              confirmTimerRef.current = setTimeout(() => {
                setConfirmingHunkIndex(null);
                confirmTimerRef.current = null;
              }, 5000);
            }
          };

          const handleConfirmDiscard = () => {
            clearConfirmTimer();
            setConfirmingHunkIndex(null);
            void handleDiscardHunk();
          };

          const handleCancelDiscard = () => {
            clearConfirmTimer();
            setConfirmingHunkIndex(null);
          };

          return (
          <div key={hunkIdx}>
            {/* Hunk header */}
            <div className="flex items-center px-2 py-0.5 text-[10px] font-mono text-blue-400/60 bg-blue-500/[0.04] select-none sticky top-0">
              <span className="flex-1 truncate">{hunk.header}</span>
              {showHunkActions && (
                isConfirming ? (
                  <div className="flex items-center gap-1 ml-2 shrink-0 select-none">
                    <span className="text-red-400/80 text-[10px] font-sans whitespace-nowrap">
                      Really discard {netChangeCount(hunk)} lines?
                    </span>
                    <button
                      onClick={handleCancelDiscard}
                      aria-label="Cancel"
                      className="px-1.5 py-px rounded text-[10px] font-sans text-text-tertiary hover:text-text-primary hover:bg-white/[0.08] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirmDiscard}
                      aria-label="Discard"
                      className="px-1.5 py-px rounded text-[10px] font-sans text-red-400 hover:text-red-300 hover:bg-red-500/20 transition-colors"
                    >
                      Discard
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-0.5 ml-2 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleStageHunk(); }}
                      aria-label="Stage hunk"
                      title="Stage hunk"
                      className="p-0.5 rounded text-green-500/70 hover:text-green-400 hover:bg-green-500/10 transition-colors"
                    >
                      <Check size={11} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDiscardClick(); }}
                      aria-label="Discard hunk"
                      title="Discard hunk"
                      className="p-0.5 rounded text-red-500/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              )}
            </div>
            {/* Lines */}
            {hunk.lines.map((line, lineIdx) => {
              const bgClass =
                line.type === 'added'
                  ? 'bg-green-500/[0.08]'
                  : line.type === 'removed'
                    ? 'bg-red-500/[0.08]'
                    : '';
              const textClass =
                line.type === 'added'
                  ? 'text-green-400'
                  : line.type === 'removed'
                    ? 'text-red-400'
                    : 'text-text-secondary';
              const prefix =
                line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

              return (
                <div
                  key={`${hunkIdx}-${lineIdx}`}
                  className={`flex font-mono text-[11px] leading-[18px] ${bgClass} hover:brightness-125 transition-all`}
                >
                  {/* Old line number */}
                  <span
                    className="text-text-tertiary/50 select-none text-right shrink-0 px-1"
                    style={{ width: `${numWidth + 1}ch` }}
                  >
                    {line.oldLineNumber ?? ''}
                  </span>
                  {/* New line number */}
                  <span
                    className="text-text-tertiary/50 select-none text-right shrink-0 px-1 border-r border-border/20 mr-1"
                    style={{ width: `${numWidth + 1}ch` }}
                  >
                    {line.newLineNumber ?? ''}
                  </span>
                  {/* Prefix */}
                  <span className={`${textClass} select-none shrink-0 w-[1ch]`}>
                    {prefix}
                  </span>
                  {/* Content */}
                  <span className={`${textClass} whitespace-pre pr-2`}>
                    {line.content}
                  </span>
                </div>
              );
            })}
          </div>
          );
        })}
      </div>

      {truncated && (
        <div className="px-3 py-1.5 border-t border-border/30">
          <p className="text-yellow-400/70 text-[10px]">Diff truncated - file too large to display fully</p>
        </div>
      )}
    </div>
  );
}
