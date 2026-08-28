import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import {
  Search as SearchIcon,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  CaseSensitive,
  FileCode2,
  AlertCircle,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

interface SearchMatch {
  line: number;
  column: number;
  line_text: string;
  match_length: number;
  preview_column: number;
}

interface FileSearchResult {
  file_path: string;
  relative_path: string;
  matches: SearchMatch[];
  name_match: boolean;
}

interface SearchSummary {
  results: FileSearchResult[];
  total_matches: number;
  total_files: number;
  truncated: boolean;
}

// Render a line preview with the matched substring highlighted.
function HighlightedLine({
  text,
  column,
  matchLength,
}: {
  text: string;
  column: number;
  matchLength: number;
}) {
  const start = Math.max(0, column - 1);
  const end = Math.min(text.length, start + matchLength);
  if (end <= start) {
    return <span>{text}</span>;
  }
  // Trim long lines around the match for readability
  const previewStart = Math.max(0, start - 80);
  const before = previewStart > 0 ? '…' + text.slice(previewStart, start) : text.slice(0, start);
  const matched = text.slice(start, end);
  const after = text.slice(end);
  return (
    <>
      <span className="text-text-tertiary">{before}</span>
      <span className="bg-accent-primary/30 text-text-primary rounded-[2px] px-[1px]">
        {matched}
      </span>
      <span className="text-text-tertiary">{after}</span>
    </>
  );
}

export function GlobalSearchModal() {
  const closeGlobalSearch = useAppStore((s) => s.closeGlobalSearch);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const requestEditorNavigation = useAppStore((s) => s.requestEditorNavigation);
  const pinnedRepoPath = useAppStore((s) => s.pinnedRepoPath);
  const activeCwd = useTerminalStore((s) => {
    const id = s.activeTerminalId;
    return id ? s.terminals.get(id)?.config.working_directory ?? null : null;
  });

  const searchRoot = pinnedRepoPath ?? activeCwd;

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searching, setSearching] = useState(false);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ fileIdx: number; matchIdx: number }>({
    fileIdx: 0,
    matchIdx: 0,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Token to ignore stale debounced searches
  const searchToken = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Debounced search
  useEffect(() => {
    if (!searchRoot) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSummary(null);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const myToken = ++searchToken.current;
    const handle = setTimeout(async () => {
      try {
        const res = await invoke<SearchSummary>('search_in_files', {
          path: searchRoot,
          query: trimmed,
          caseSensitive,
          includeFileContents: true,
        });
        if (myToken !== searchToken.current) return;
        setSummary(res);
        setError(null);
        setCollapsedFiles(new Set());
        setSelected({ fileIdx: 0, matchIdx: 0 });
      } catch (err) {
        if (myToken !== searchToken.current) return;
        setError(typeof err === 'string' ? err : 'Search failed');
        setSummary(null);
      } finally {
        if (myToken === searchToken.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, caseSensitive, searchRoot]);

  const results = summary?.results ?? [];

  // Build a flat list of (fileIdx, matchIdx) entries that respects collapsed
  // groups, so arrow keys move between visible matches in document order.
  const flatNav = useMemo(() => {
    const out: { fileIdx: number; matchIdx: number }[] = [];
    results.forEach((file, fileIdx) => {
      if (collapsedFiles.has(file.file_path)) return;
      file.matches.forEach((_, matchIdx) => {
        out.push({ fileIdx, matchIdx });
      });
      if (file.matches.length === 0) {
        // File has only a name match - represent it as a single entry
        out.push({ fileIdx, matchIdx: -1 });
      }
    });
    return out;
  }, [results, collapsedFiles]);

  const flatIndex = useMemo(() => {
    return flatNav.findIndex(
      (e) => e.fileIdx === selected.fileIdx && e.matchIdx === selected.matchIdx,
    );
  }, [flatNav, selected]);

  const openMatch = useCallback(
    async (file: FileSearchResult, match?: SearchMatch) => {
      try {
        await openFileTab(file.file_path);
        if (match) requestEditorNavigation(file.file_path, match.line, match.column);
        closeGlobalSearch();
      } catch {
        /* errors surface via the file tab itself */
      }
    },
    [openFileTab, requestEditorNavigation, closeGlobalSearch],
  );

  const toggleFile = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const moveSelection = (delta: number) => {
    if (flatNav.length === 0) return;
    const idx = flatIndex < 0 ? 0 : flatIndex;
    const next = (idx + delta + flatNav.length) % flatNav.length;
    setSelected(flatNav[next]);
    // Scroll into view
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-nav="${flatNav[next].fileIdx}-${flatNav[next].matchIdx}"]`,
      );
      el?.scrollIntoView({ block: 'nearest' });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGlobalSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = results[selected.fileIdx];
      if (file) openMatch(file, selected.matchIdx >= 0 ? file.matches[selected.matchIdx] : undefined);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[60] bg-black/50 flex items-start justify-center pt-[8vh]"
      onMouseDown={(e) => {
        // Click on backdrop (not modal) closes
        if (e.target === e.currentTarget) closeGlobalSearch();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: -8 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="w-full max-w-[820px] mx-4 bg-elevation-3 ring-1 ring-white/[0.08] rounded-xl overflow-hidden flex flex-col"
        style={{ maxHeight: '80vh' }}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-text-primary text-[13px] font-semibold">
            <SearchIcon size={14} className="text-accent-primary" />
            Search in Files
          </div>
          <button
            onClick={closeGlobalSearch}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary hover:text-text-primary transition-colors"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Search input row */}
        <div className="px-4 py-3 border-b border-border">
          <div className="relative flex items-center">
            <SearchIcon
              size={13}
              className="absolute left-3 text-text-tertiary"
              strokeWidth={1.75}
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across the workspace…"
              className="w-full bg-elevation-1 ring-1 ring-inset ring-border rounded-md h-9 pl-9 pr-24 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary/60"
            />
            <div className="absolute right-2 flex items-center gap-1">
              <button
                onClick={() => setCaseSensitive((v) => !v)}
                className={`h-7 w-7 flex items-center justify-center rounded transition-colors ${
                  caseSensitive
                    ? 'bg-accent-primary/20 text-accent-primary ring-1 ring-inset ring-accent-primary/40'
                    : 'text-text-tertiary hover:bg-white/[0.06] hover:text-text-secondary'
                }`}
                title="Match case (Aa)"
                tabIndex={-1}
              >
                <CaseSensitive size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {/* Status line */}
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <div className="text-text-tertiary truncate" title={searchRoot ?? ''}>
              {searchRoot ? (
                <>
                  in <span className="font-mono text-text-secondary">{searchRoot}</span>
                </>
              ) : (
                'No active workspace - open a terminal first'
              )}
            </div>
            <div className="text-text-tertiary flex items-center gap-2">
              {searching && <Loader2 size={11} className="animate-spin" />}
              {summary && !searching && (
                <span>
                  {summary.total_matches} match
                  {summary.total_matches === 1 ? '' : 'es'} in {summary.total_files} file
                  {summary.total_files === 1 ? '' : 's'}
                  {summary.truncated && ' (truncated)'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-error">
              <AlertCircle size={13} />
              {error}
            </div>
          )}

          {!error && !searching && summary && summary.results.length === 0 && query.trim() && (
            <div className="px-4 py-6 text-center text-text-tertiary text-[12px]">
              No matches found
            </div>
          )}

          {!error && !query.trim() && (
            <div className="px-4 py-6 text-center text-text-tertiary text-[12px]">
              Type to search file names and contents across the workspace.
            </div>
          )}

          {!error &&
            results.map((file, fileIdx) => {
              const collapsed = collapsedFiles.has(file.file_path);
              const fileSelected = selected.fileIdx === fileIdx && selected.matchIdx === -1;
              return (
                <div key={file.file_path} className="mb-0.5">
                  <button
                    data-nav={`${fileIdx}--1`}
                    onClick={() => toggleFile(file.file_path)}
                    onDoubleClick={() => openMatch(file)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 text-left transition-colors ${
                      fileSelected
                        ? 'bg-accent-primary/10'
                        : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    {collapsed ? (
                      <ChevronRight size={11} className="text-text-tertiary flex-shrink-0" strokeWidth={1.75} />
                    ) : (
                      <ChevronDown size={11} className="text-text-tertiary flex-shrink-0" strokeWidth={1.75} />
                    )}
                    <FileCode2 size={11} className="text-text-tertiary flex-shrink-0" strokeWidth={1.75} />
                    <span className="text-[12px] text-text-primary font-mono truncate" title={file.relative_path}>
                      {file.relative_path}
                    </span>
                    {file.name_match && (
                      <span className="text-[9px] uppercase tracking-wider text-accent-primary bg-accent-primary/15 px-1 rounded flex-shrink-0">
                        name
                      </span>
                    )}
                    <span className="text-text-tertiary text-[10.5px] flex-shrink-0 ml-auto">
                      {file.matches.length || (file.name_match ? '·' : 0)}
                    </span>
                  </button>

                  {!collapsed && (
                    <div className="ml-5 border-l border-border">
                      {file.matches.map((m, matchIdx) => {
                        const isSelected =
                          selected.fileIdx === fileIdx && selected.matchIdx === matchIdx;
                        return (
                          <button
                            key={`${m.line}-${matchIdx}`}
                            data-nav={`${fileIdx}-${matchIdx}`}
                            onClick={() => {
                              setSelected({ fileIdx, matchIdx });
                              openMatch(file, m);
                            }}
                            onMouseEnter={() => setSelected({ fileIdx, matchIdx })}
                            className={`w-full flex items-baseline gap-2 px-3 py-0.5 text-left transition-colors ${
                              isSelected ? 'bg-accent-primary/12' : 'hover:bg-white/[0.04]'
                            }`}
                          >
                            <span className="text-text-tertiary text-[10.5px] font-mono flex-shrink-0 w-8 text-right tabular-nums">
                              {m.line}
                            </span>
                            <span className="text-[12px] font-mono truncate flex-1 min-w-0">
                              <HighlightedLine
                                text={m.line_text}
                                column={m.preview_column}
                                matchLength={m.match_length}
                              />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-text-tertiary">
          <span>
            <kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">↵</kbd> open file
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">Aa</kbd> match case
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}
