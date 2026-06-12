import { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import {
  Terminal,
  Settings,
  PanelLeft,
  LayoutGrid,
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

interface PaletteItem {
  id: string;
  // Stable key for frecency tracking. Empty string = not tracked (terminals,
  // whose ids are ephemeral and must not leak into persisted usage).
  frecencyKey: string;
  label: string;
  description: string;
  category: string;
  icon?: LucideIcon;
  shortcut?: string;
  // Tailwind bg-* class for a presence dot (terminal status). Color is
  // supplementary - the status is also spelled out in the description so we
  // never convey it by color alone.
  statusColor?: string;
  action: () => void;
}

// Terminal status → presence-dot color.
const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

// Frecency = frequency + recency. A small recency bump keeps recently-used
// items near the top without letting a one-off click outrank a daily habit.
function frecencyScore(u?: { count: number; lastUsedTs: number }): number {
  if (!u) return 0;
  const age = Date.now() - u.lastUsedTs;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const recency = age < HOUR ? 8 : age < DAY ? 4 : age < 7 * DAY ? 2 : 1;
  return u.count + recency;
}

function fuzzyMatch(text: string, query: string): { matches: boolean; score: number } {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();

  // Exact substring match (highest score)
  const subIdx = lower.indexOf(q);
  if (subIdx !== -1) {
    // Prefer matches at the start
    return { matches: true, score: 100 - subIdx };
  }

  // Character-by-character fuzzy match
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      qi++;
      // Bonus for consecutive matches
      score += lastMatchIdx === i - 1 ? 3 : 1;
      lastMatchIdx = i;
    }
  }
  if (qi === q.length) {
    return { matches: true, score };
  }
  return { matches: false, score: 0 };
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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

    // Terminals
    if (prefixMode === 'all' || prefixMode === 'terminals') {
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
    if (prefixMode === 'all' || prefixMode === 'commands') {
      const actions: { label: string; description: string; icon: LucideIcon; shortcut?: string; action: () => void }[] = [
        { label: 'New Terminal', description: 'Create a new terminal instance', icon: Plus, shortcut: 'Ctrl+Shift+N', action: () => { useAppStore.getState().openNewTerminalModal(); closeCommandPalette(); } },
        { label: 'Toggle Sidebar', description: 'Show or hide the sidebar', icon: PanelLeft, shortcut: 'Ctrl+B', action: () => { useAppStore.getState().toggleSidebar(); closeCommandPalette(); } },
        { label: 'Open Settings', description: 'Open application settings', icon: Settings, shortcut: 'Ctrl+,', action: () => { useAppStore.getState().openSettings(); closeCommandPalette(); } },
        { label: 'Toggle Grid View', description: 'Switch between tab and grid view', icon: LayoutGrid, shortcut: 'Ctrl+G', action: () => { useAppStore.getState().toggleGridMode(); closeCommandPalette(); } },
        { label: 'Toggle Hints Panel', description: 'Show or hide Claude Code hints', icon: Lightbulb, shortcut: 'F1', action: () => { useAppStore.getState().toggleHints(); closeCommandPalette(); } },
        { label: 'Toggle File Changes', description: 'Show or hide the file changes panel', icon: FileCode, shortcut: 'F2', action: () => { useAppStore.getState().toggleChanges(); closeCommandPalette(); } },
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
    if (prefixMode === 'all' || prefixMode === 'commands') {
      hints.forEach((cat) => {
        cat.hints.forEach((hint, i) => {
          result.push({
            id: `hint-${cat.category}-${i}`,
            frecencyKey: `hint:${hint.command}`,
            label: hint.command,
            description: hint.description,
            category: 'Hints',
            icon: Copy,
            action: () => { navigator.clipboard.writeText(hint.command); closeCommandPalette(); },
          });
        });
      });
    }

    // Snippets
    if (prefixMode === 'all' || prefixMode === 'snippets') {
      snippets.forEach((snippet) => {
        result.push({
          id: `snippet-${snippet.id}`,
          frecencyKey: `snippet:${snippet.id}`,
          label: snippet.title,
          description: `[${snippet.category}] ${snippet.content.slice(0, 60)}${snippet.content.length > 60 ? '...' : ''}`,
          category: 'Snippets',
          icon: Send,
          action: () => {
            if (activeTerminalId) writeToTerminal(activeTerminalId, snippet.content);
            closeCommandPalette();
          },
        });
      });
    }

    return result;
  }, [terminals, hints, snippets, activeTerminalId, closeCommandPalette, setActiveTerminal, writeToTerminal, prefixMode]);

  const filtered = useMemo(() => {
    if (!effectiveQuery) return items;
    return items
      .map(item => {
        const labelMatch = fuzzyMatch(item.label, effectiveQuery);
        const descMatch = fuzzyMatch(item.description, effectiveQuery);
        const bestScore = Math.max(labelMatch.score, descMatch.score);
        // Nudge frequently/recently used matches up without overriding a strong
        // textual match (fuzzy scores dominate; the boost only breaks ties).
        const boost = item.frecencyKey ? frecencyScore(paletteUsage[item.frecencyKey]) * 1.5 : 0;
        return { item, matches: labelMatch.matches || descMatch.matches, score: bestScore + boost };
      })
      .filter(r => r.matches)
      .sort((a, b) => b.score - a.score)
      .map(r => r.item);
  }, [items, effectiveQuery, paletteUsage]);

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
    for (const item of filtered) {
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
        initial={{ opacity: 0, scale: 0.96, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -8 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="mx-auto mt-[15vh] w-full max-w-[550px]"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="bg-elevation-4 ring-1 ring-white/[0.08] rounded-xl overflow-hidden">
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
                          : 'hover:bg-white/[0.04] text-text-secondary'
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
                        <p className="text-[12px] font-medium truncate">{item.label}</p>
                        <p className="text-text-tertiary text-[11px] truncate">{item.description}</p>
                      </div>
                      {item.shortcut && (
                        <kbd className="shrink-0 text-[10px] text-text-tertiary bg-elevation-2 px-1.5 py-0.5 rounded border border-border font-mono">
                          {item.shortcut}
                        </kbd>
                      )}
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

          {/* Footer hint */}
          <div className="px-3 py-2 border-t border-border flex items-center gap-4 text-[10px] text-text-tertiary">
            <span><kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">↵</kbd> select</span>
            <span><kbd className="px-1 py-0.5 bg-elevation-2 rounded border border-border font-mono">esc</kbd> close</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
