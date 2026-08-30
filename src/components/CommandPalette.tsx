import { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { copyText } from '../lib/clipboard';
import { reportInvokeFailure } from '../lib/errorReporter';
import { fuzzyMatch, frecencyScore } from '../lib/paletteMatching';
import { PALETTE_SOURCES, type PaletteItem } from '../lib/paletteSources';
import { HighlightedText } from './palette/HighlightedText';
import {
  Terminal,
  Settings,
  PanelLeft,
  LayoutGrid,
  LayoutList,
  Lightbulb,
  FolderOpen,
  User,
  History,
  Scissors,
  FileCode,
  Search,
  Plus,
  Copy,
  Send,
  type LucideIcon,
} from 'lucide-react';

interface HintCategory {
  category: string;
  hints: { command: string; description: string }[];
}

interface Snippet {
  id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
}

// Terminal status → presence-dot color.
const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

// Filter chip in the source strip. Rendered inline in CommandPalette;
// pulled out so both the "All" chip and the per-source chips can share
// styling.
function ChipButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] transition-colors whitespace-nowrap ${
        active
          ? 'bg-accent-primary text-white'
          : 'bg-elevation-2 text-text-secondary hover:bg-elevation-3 hover:text-text-primary'
      }`}
    >
      <Icon size={11} strokeWidth={2} />
      {label}
    </button>
  );
}

export function CommandPalette() {
  const { closeCommandPalette } = useAppStore();
  const paletteUsage = useAppStore((s) => s.paletteUsage);
  const recordPaletteUse = useAppStore((s) => s.recordPaletteUse);
  const { terminals, activeTerminalId, setActiveTerminal, writeToTerminal } = useTerminalStore();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hints, setHints] = useState<HintCategory[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  // Chip-strip filter. 'all' means no chip filter is active; a source id
  // (e.g. 'terminals') restricts results to that source. Typed prefix chars
  // still take precedence - see `wantSource` below.
  const [activeSourceId, setActiveSourceId] = useState<string>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Reset chip filter each time the palette is (re)opened.
    setActiveSourceId('all');
    // Hints and snippets are best-effort - the palette is usable without them,
    // so a load failure just leaves those sections empty.
    invoke<HintCategory[]>('get_hints').then(setHints).catch(() => {});
    invoke<Snippet[]>('get_snippets').then(setSnippets).catch(() => {});
  }, []);

  // Determine prefix mode
  const prefixMode = useMemo(() => {
    if (query.startsWith('>')) return 'commands';
    if (query.startsWith('@')) return 'terminals';
    if (query.startsWith('#')) return 'snippets';
    return 'all';
  }, [query]);

  const effectiveQuery = useMemo(() => {
    if (prefixMode !== 'all') return query.slice(1).trim();
    return query;
  }, [query, prefixMode]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    // Should the given source contribute items right now?
    // - Typed prefix wins (backward compat with muscle memory).
    // - '>' historically surfaced BOTH Commands and Hints together, so we
    //   preserve that pairing even though the chip strip treats them as two
    //   separate sources.
    // - Otherwise, if a chip is active, filter to that source.
    // - Else show every source.
    const wantSource = (sourceId: string) => {
      if (prefixMode !== 'all') {
        return prefixMode === sourceId || (prefixMode === 'commands' && sourceId === 'hints');
      }
      if (activeSourceId !== 'all') return activeSourceId === sourceId;
      return true;
    };

    // Terminals
    if (wantSource('terminals')) {
      terminals.forEach((instance) => {
        const config = instance.config;
        result.push({
          id: `terminal-${config.id}`,
          frecencyKey: '',
          label: config.nickname || config.label,
          description: `${config.working_directory} (${config.status})`,
          category: 'Terminals',
          icon: Terminal,
          statusColor: STATUS_DOT[config.status] ?? 'bg-text-tertiary',
          action: () => { setActiveTerminal(config.id); closeCommandPalette(); },
        });
      });
    }

    // Actions
    if (wantSource('commands')) {
      const actions: { label: string; description: string; icon: LucideIcon; shortcut?: string; action: () => void }[] = [
        { label: 'New Terminal', description: 'Create a new terminal instance', icon: Plus, shortcut: 'Ctrl+Shift+N', action: () => { useAppStore.getState().openNewTerminalModal(); closeCommandPalette(); } },
        { label: 'Toggle Sidebar', description: 'Show or hide the sidebar', icon: PanelLeft, shortcut: 'Ctrl+B', action: () => { useAppStore.getState().toggleSidebar(); closeCommandPalette(); } },
        { label: 'Open Settings', description: 'Open application settings', icon: Settings, shortcut: 'Ctrl+,', action: () => { useAppStore.getState().openSettings(); closeCommandPalette(); } },
        { label: 'Toggle Grid View', description: 'Switch between tab and grid view', icon: LayoutGrid, shortcut: 'Ctrl+G', action: () => { useAppStore.getState().toggleGridMode(); closeCommandPalette(); } },
        { label: 'Toggle Hints Panel', description: 'Show or hide Claude Code hints', icon: Lightbulb, shortcut: 'F1', action: () => { useAppStore.getState().toggleHints(); closeCommandPalette(); } },
        { label: 'Toggle Git', description: 'Show or hide the Git panel', icon: FileCode, shortcut: 'F2', action: () => { useAppStore.getState().toggleChanges(); closeCommandPalette(); } },
        { label: 'Manage Profiles', description: 'Open profile management', icon: User, action: () => { useAppStore.getState().openProfileModal(); closeCommandPalette(); } },
        { label: 'Workspaces', description: 'Open workspace manager', icon: FolderOpen, action: () => { useAppStore.getState().openWorkspaceModal(); closeCommandPalette(); } },
        { label: 'Snippets', description: 'Open snippet manager', icon: Scissors, shortcut: 'Ctrl+Shift+S', action: () => { useAppStore.getState().openSnippetsModal(); closeCommandPalette(); } },
        { label: 'Session History', description: 'View past terminal sessions', icon: History, action: () => { useAppStore.getState().openSessionHistory(); closeCommandPalette(); } },
      ];
      actions.forEach((a, i) => {
        result.push({ id: `action-${i}`, frecencyKey: `cmd:${a.label}`, label: a.label, description: a.description, category: 'Commands', icon: a.icon, shortcut: a.shortcut, action: a.action });
      });
    }

    // Hints
    if (wantSource('hints')) {
      hints.forEach((cat) => {
        cat.hints.forEach((hint, i) => {
          result.push({
            id: `hint-${cat.category}-${i}`,
            frecencyKey: `hint:${hint.command}`,
            label: hint.command,
            description: hint.description,
            category: 'Hints',
            icon: Copy,
            action: () => {
              // copyText survives WebView2 focus gating (bare navigator.clipboard doesn't).
              copyText(hint.command).then((ok) => {
                if (!ok) toast.error('Copy failed', 'Could not write to the clipboard.');
              });
              closeCommandPalette();
            },
          });
        });
      });
    }

    // Snippets
    if (wantSource('snippets')) {
      snippets.forEach((snippet) => {
        result.push({
          id: `snippet-${snippet.id}`,
          frecencyKey: `snippet:${snippet.id}`,
          label: snippet.title,
          description: `[${snippet.category}] ${snippet.content.slice(0, 60)}${snippet.content.length > 60 ? '...' : ''}`,
          category: 'Snippets',
          icon: Send,
          action: () => {
            if (activeTerminalId) {
              writeToTerminal(activeTerminalId, snippet.content).catch((err) => {
                toast.error('Insert failed', 'Could not send the snippet to the terminal.');
                reportInvokeFailure('write_to_terminal', err);
              });
            }
            closeCommandPalette();
          },
        });
      });
    }

    return result;
  }, [terminals, hints, snippets, activeTerminalId, closeCommandPalette, setActiveTerminal, writeToTerminal, prefixMode, activeSourceId]);

  // Task C: each surviving result also carries the match positions for
  // label + description so the renderer can highlight the matched chars.
  interface FilteredItem {
    item: PaletteItem;
    labelPositions: number[];
    descPositions: number[];
  }

  const filtered = useMemo<FilteredItem[]>(() => {
    if (!effectiveQuery) {
      return items.map(item => ({ item, labelPositions: [], descPositions: [] }));
    }
    return items
      .map(item => {
        const labelMatch = fuzzyMatch(item.label, effectiveQuery);
        const descMatch = fuzzyMatch(item.description, effectiveQuery);
        const bestScore = Math.max(labelMatch.score, descMatch.score);
        // Nudge frequently/recently used matches up without overriding a strong
        // textual match (fuzzy scores dominate; the boost only breaks ties).
        const boost = item.frecencyKey ? frecencyScore(paletteUsage[item.frecencyKey]) * 1.5 : 0;
        return {
          item,
          matches: labelMatch.matches || descMatch.matches,
          score: bestScore + boost,
          labelPositions: labelMatch.matches ? labelMatch.positions : [],
          descPositions: descMatch.matches ? descMatch.positions : [],
        };
      })
      .filter(r => r.matches)
      .sort((a, b) => b.score - a.score)
      .map(({ item, labelPositions, descPositions }) => ({ item, labelPositions, descPositions }));
  }, [items, effectiveQuery, paletteUsage]);

  // Task C: keep grouped/flatItems as PaletteItem[] (they're used all over the
  // render pass) and stash positions in a side-map keyed by item id. When the
  // query is empty every list is [], so highlighting is a no-op automatically.
  const positionsMap = useMemo(() => {
    const m = new Map<string, { label: number[]; desc: number[] }>();
    for (const f of filtered) {
      m.set(f.item.id, { label: f.labelPositions, desc: f.descPositions });
    }
    return m;
  }, [filtered]);

  // Recent group (empty query only): tracked items ordered by last use.
  const recentItems = useMemo(() => {
    if (effectiveQuery) return [];
    const byKey = new Map(items.filter(i => i.frecencyKey).map(i => [i.frecencyKey, i] as const));
    return Object.entries(paletteUsage)
      .sort((a, b) => b[1].lastUsedTs - a[1].lastUsedTs)
      .map(([k]) => byKey.get(k))
      .filter((i): i is PaletteItem => !!i)
      .slice(0, 5);
  }, [items, paletteUsage, effectiveQuery]);

  // Group by category. With an empty query, surface "Recent" first and drop
  // those items from their normal groups so each appears exactly once.
  const grouped = useMemo(() => {
    const groups: { category: string; items: PaletteItem[] }[] = [];
    if (recentItems.length) groups.push({ category: 'Recent', items: recentItems });
    const recentKeys = new Set(recentItems.map(i => i.frecencyKey));
    const catMap = new Map<string, PaletteItem[]>();
    for (const { item } of filtered) {
      if (!effectiveQuery && item.frecencyKey && recentKeys.has(item.frecencyKey)) continue;
      const arr = catMap.get(item.category) || [];
      arr.push(item);
      catMap.set(item.category, arr);
    }
    for (const [category, items] of catMap) {
      groups.push({ category, items });
    }
    return groups;
  }, [filtered, recentItems, effectiveQuery]);

  // Flat list for keyboard navigation
  const flatItems = useMemo(() => grouped.flatMap(g => g.items), [grouped]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Record frecency before running, so the next open reflects this use.
  const runItem = (item: PaletteItem) => {
    if (item.frecencyKey) recordPaletteUse(item.frecencyKey);
    item.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+Tab cycles the chip filter forward; Ctrl+Shift+Tab cycles back.
    // Order matches the chip strip: All → Terminals → Commands → Hints → Snippets → All.
    // Plain Tab is left alone so the input keeps its default behavior.
    if (e.key === 'Tab' && e.ctrlKey) {
      e.preventDefault();
      const ids = ['all', ...PALETTE_SOURCES.map((s) => s.id)];
      const currentIdx = Math.max(0, ids.indexOf(activeSourceId));
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + ids.length) % ids.length
        : (currentIdx + 1) % ids.length;
      setActiveSourceId(ids[nextIdx]);
      return;
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flatItems[selectedIndex]) {
        runItem(flatItems[selectedIndex]);
      }
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Placeholder text based on prefix mode
  const placeholder = useMemo(() => {
    switch (prefixMode) {
      case 'commands': return 'Search commands...';
      case 'terminals': return 'Search terminals...';
      case 'snippets': return 'Search snippets...';
      default: return 'Search commands, terminals, snippets...  (> cmds  @ terms  # snips)';
    }
  }, [prefixMode]);

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50"
      onDoubleClick={closeCommandPalette}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: -10 }}
        animate={{
          opacity: 1,
          scale: 1,
          y: 0,
          transition: { type: 'spring', bounce: 0, duration: 0.3, opacity: { duration: 0.15, ease: 'easeOut' } },
        }}
        exit={{ opacity: 0, scale: 0.97, y: -8, transition: { duration: 0.12, ease: 'easeOut' } }}
        className="mx-auto mt-[15vh] w-full max-w-[550px]"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Spotlight-style glass panel */}
        <div className="material-overlay rounded-xl overflow-hidden">
          {/* Search Input */}
          <div className="p-3 border-b border-border">
            <div className="relative flex items-center">
              <Search size={14} className="absolute left-3 text-text-tertiary" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="w-full bg-elevation-2 ring-1 ring-border-light rounded-lg h-10 pl-9 pr-3 text-text-primary text-[13px] focus:outline-none focus:ring-border-focus transition-all placeholder:text-text-tertiary"
              />
            </div>
          </div>

          {/* Source filter chips */}
          <div
            role="group"
            aria-label="Filter by source"
            className="px-3 pt-2 pb-2 flex items-center gap-1 border-b border-border overflow-x-auto scrollbar-none"
          >
            <ChipButton
              label="All"
              icon={LayoutList}
              active={activeSourceId === 'all' && prefixMode === 'all'}
              onClick={() => {
                // Clicking "All" clears the chip filter and also strips any
                // typed prefix char so users don't get "stuck" in a mode
                // they can't see.
                setActiveSourceId('all');
                if (prefixMode !== 'all') setQuery(query.slice(1).trimStart());
              }}
            />
            {PALETTE_SOURCES.map((src) => {
              // Highlight the chip when either (a) it's the active chip and
              // no typed prefix is fighting it, or (b) the typed prefix
              // matches this source - so muscle-memory users still see
              // which source their prefix maps to.
              const active =
                (activeSourceId === src.id && prefixMode === 'all') ||
                prefixMode === src.id;
              return (
                <ChipButton
                  key={src.id}
                  label={src.label}
                  icon={src.icon}
                  active={active}
                  onClick={() =>
                    setActiveSourceId(activeSourceId === src.id ? 'all' : src.id)
                  }
                />
              );
            })}
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
            {grouped.map((group) => (
              <div key={group.category}>
                <div className="px-2.5 py-1.5 text-text-tertiary text-[10px] font-semibold uppercase tracking-widest">
                  {group.category}
                </div>
                {group.items.map((item) => {
                  const idx = flatIndex++;
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      data-index={idx}
                      onClick={() => runItem(item)}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        selectedIndex === idx
                          ? 'bg-accent-primary/12 text-text-primary'
                          : 'hover:bg-fill-hover text-text-secondary'
                      }`}
                    >
                      {Icon && (
                        <div className="relative shrink-0">
                          <Icon
                            size={14}
                            className={selectedIndex === idx ? 'text-accent-primary' : 'text-text-tertiary'}
                          />
                          {item.statusColor && (
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-elevation-4 ${item.statusColor}`}
                              title="Terminal status"
                            />
                          )}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium truncate">
                          <HighlightedText
                            text={item.label}
                            positions={positionsMap.get(item.id)?.label ?? []}
                          />
                        </p>
                        <p className="text-text-tertiary text-[11px] truncate">
                          <HighlightedText
                            text={item.description}
                            positions={positionsMap.get(item.id)?.desc ?? []}
                          />
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {flatItems.length === 0 && (
              <p className="text-text-tertiary text-[12px] text-center py-8">
                No results found
              </p>
            )}
          </div>

        </div>
      </motion.div>
    </div>
  );
}
