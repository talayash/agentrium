import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, MessageSquarePlus, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { parseDiff, type DiffHunk } from '../utils/diffParser';
import { useReviewStore } from '../store/reviewStore';
import { Button } from './ui/Button';

interface FileDiffResult {
  file_path: string;
  diff_text: string;
  is_new_file: boolean;
  is_deleted_file: boolean;
  is_binary: boolean;
}

interface InlineDiffViewProps {
  filePath: string;
  terminalId: string;
  pathOverride?: string | null;
}

const MAX_DIFF_SIZE = 100_000; // 100KB guard
const MAX_SNIPPET = 120;

interface Anchor {
  side: 'new' | 'old';
  line: number;
}

export function InlineDiffView({ filePath, terminalId, pathOverride }: InlineDiffViewProps) {
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [isBinary, setIsBinary] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [editing, setEditing] = useState<Anchor | null>(null);
  const [draft, setDraft] = useState('');
  const allComments = useReviewStore((st) => st.comments);
  const addComment = useReviewStore((st) => st.add);
  const removeComment = useReviewStore((st) => st.remove);

  const fetchDiff = async (showStaged: boolean) => {
    setLoading(true);
    setError(null);
    setTruncated(false);
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
    setEditing(null);
    setDraft('');
  }, [filePath, terminalId, pathOverride, staged]);

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

  const closeEditor = () => {
    setEditing(null);
    setDraft('');
  };
  const saveComment = (snippet: string) => {
    const body = draft.trim();
    if (editing && body) {
      addComment({ terminalId, filePath, repoPath: pathOverride ?? undefined, side: editing.side, line: editing.line, snippet, body });
    }
    closeEditor();
  };

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
        {hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx}>
            {/* Hunk header */}
            <div className="px-2 py-0.5 text-[10px] font-mono text-blue-400/60 bg-blue-500/[0.04] select-none sticky top-0">
              {hunk.header}
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

              const anchor: Anchor | null =
                line.type === 'header'
                  ? null
                  : line.type === 'removed'
                    ? line.oldLineNumber != null ? { side: 'old', line: line.oldLineNumber } : null
                    : line.newLineNumber != null ? { side: 'new', line: line.newLineNumber } : null;
              const snippet = line.content.trim().slice(0, MAX_SNIPPET);
              const lineComments = anchor
                ? allComments.filter(
                    (c) => c.terminalId === terminalId && c.filePath === filePath
                      && c.repoPath === (pathOverride ?? undefined)
                      && c.side === anchor.side && c.line === anchor.line,
                  )
                : [];
              const isEditingHere = !!anchor && editing?.side === anchor.side && editing.line === anchor.line;

              return (
                <div key={`${hunkIdx}-${lineIdx}`}>
                <div
                  className={`group relative flex font-mono text-[11px] leading-[18px] ${bgClass} hover:brightness-125 transition-all`}
                >
                  {anchor && (
                    <button
                      type="button"
                      aria-label={`Comment on line ${anchor.line}`}
                      onClick={() => { setEditing(anchor); setDraft(''); }}
                      className="absolute right-1 top-0 h-[18px] px-1 opacity-0 group-hover:opacity-100 focus:opacity-100 text-text-tertiary hover:text-accent-primary transition-opacity"
                    >
                      <MessageSquarePlus size={12} />
                    </button>
                  )}
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
                {lineComments.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 mx-2 my-1 px-2 py-1 rounded border border-border/50 bg-bg-secondary text-[11px] text-text-primary font-sans">
                    <span className="flex-1 whitespace-pre-wrap">{c.body}</span>
                    <button
                      type="button"
                      aria-label="Delete comment"
                      onClick={() => removeComment(c.id)}
                      className="shrink-0 text-text-tertiary hover:text-text-primary"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {isEditingHere && (
                  <div className="mx-2 my-1 p-1.5 rounded border border-border/50 bg-bg-secondary font-sans">
                    <textarea
                      autoFocus
                      aria-label="Review comment"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
                        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComment(snippet); }
                      }}
                      rows={2}
                      placeholder="Comment for the agent (Ctrl+Enter to save, Esc to cancel)"
                      className="w-full resize-none bg-transparent text-[11px] text-text-primary outline-none"
                    />
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={closeEditor}>Cancel</Button>
                      <Button variant="primary" size="sm" onClick={() => saveComment(snippet)} disabled={!draft.trim()}>Comment</Button>
                    </div>
                  </div>
                )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {truncated && (
        <div className="px-3 py-1.5 border-t border-border/30">
          <p className="text-yellow-400/70 text-[10px]">Diff truncated - file too large to display fully</p>
        </div>
      )}
    </div>
  );
}
