import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ChevronUp, ChevronDown, CaseSensitive } from 'lucide-react';
import type { SearchAddon } from '@xterm/addon-search';
import { Tooltip } from './ui/Tooltip';

interface TerminalSearchProps {
  searchAddon: SearchAddon | null;
  visible: boolean;
  onClose: () => void;
}

export function TerminalSearch({ searchAddon, visible, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      searchAddon?.clearDecorations();
      setQuery('');
    }
  }, [visible, searchAddon]);

  const doSearch = useCallback((searchQuery: string, options: { caseSensitive: boolean }, direction: 'next' | 'prev' = 'next') => {
    if (!searchAddon || !searchQuery) {
      searchAddon?.clearDecorations();
      return;
    }

    const searchOptions = {
      caseSensitive: options.caseSensitive,
      incremental: true,
      decorations: {
        matchBackground: '#3B82F640',
        matchBorder: '#3B82F6',
        matchOverviewRuler: '#3B82F6',
        activeMatchBackground: '#3B82F6',
        activeMatchBorder: '#E5E5E5',
        activeMatchColorOverviewRuler: '#E5E5E5',
      },
    };

    if (direction === 'prev') {
      searchAddon.findPrevious(searchQuery, searchOptions);
    } else {
      searchAddon.findNext(searchQuery, searchOptions);
    }
  }, [searchAddon]);

  const handleQueryChange = (newQuery: string) => {
    setQuery(newQuery);
    doSearch(newQuery, { caseSensitive });
  };

  const handleNext = () => {
    if (!query) return;
    doSearch(query, { caseSensitive }, 'next');
  };

  const handlePrev = () => {
    if (!query) return;
    doSearch(query, { caseSensitive }, 'prev');
  };

  const toggleCaseSensitive = () => {
    const newValue = !caseSensitive;
    setCaseSensitive(newValue);
    if (query) {
      doSearch(query, { caseSensitive: newValue });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        handlePrev();
      } else {
        handleNext();
      }
    }
  };

  if (!visible) return null;

  return (
    <div className="absolute top-2 right-4 z-30 flex items-center gap-1 material-popover rounded-md px-2 py-1">
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        className="w-48 bg-bg-primary ring-1 ring-border-light rounded px-2 py-1 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary transition-colors font-mono"
      />

      {/* Case sensitive toggle */}
      <Tooltip label="Match Case">
        <button
          onClick={toggleCaseSensitive}
          className={`p-1 rounded transition-colors ${
            caseSensitive
              ? 'bg-accent-primary/15 text-accent-primary'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-fill-hover'
          }`}
        >
          <CaseSensitive size={14} />
        </button>
      </Tooltip>

      {/* Previous match */}
      <Tooltip label="Previous Match" shortcut="Shift+Enter">
        <button
          onClick={handlePrev}
          disabled={!query}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-fill-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          <ChevronUp size={14} />
        </button>
      </Tooltip>

      {/* Next match */}
      <Tooltip label="Next Match" shortcut="Enter">
        <button
          onClick={handleNext}
          disabled={!query}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-fill-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        >
          <ChevronDown size={14} />
        </button>
      </Tooltip>

      {/* Close */}
      <Tooltip label="Close" shortcut="Esc">
        <button
          onClick={onClose}
          className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-fill-hover transition-colors"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
