import {
  Bell, Code2, GitBranch, Keyboard, ShieldCheck, SlidersHorizontal, Sparkles, TerminalSquare, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { NAV_SECTIONS, type NavSectionId } from './index';
import { SettingsSearch } from './SettingsSearch';

// Solid tile per section (System Settings style). These are fixed brand-neutral
// hues, not the user accent, so the sidebar reads the same under any accent.
const SECTION_ICONS: Record<NavSectionId, { icon: LucideIcon; color: string }> = {
  general:         { icon: SlidersHorizontal, color: '#0A84FF' },
  terminal:        { icon: TerminalSquare,    color: '#30B0C7' },
  editor:          { icon: Code2,             color: '#5E5CE6' },
  agents:          { icon: Sparkles,          color: '#FF9500' },
  git:             { icon: GitBranch,         color: '#FF3B30' },
  tools:           { icon: Wrench,            color: '#8E8E93' },
  notifications:   { icon: Bell,              color: '#FF2D55' },
  keymap:          { icon: Keyboard,          color: '#636366' },
  'privacy-about': { icon: ShieldCheck,       color: '#34C759' },
};

interface Props {
  active: NavSectionId;
  onSelect: (id: NavSectionId) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** Page keys matching the current query; undefined when the query is empty. */
  highlightedPages?: Set<string>;
}

export function SettingsNav({ active, onSelect, query, onQueryChange, highlightedPages }: Props) {
  return (
    // Darker translucent zone over the sheet material - structure via material
    // weight, not a second stacked surface.
    <nav aria-label="Settings sections" className="bg-black/15 border-r border-[var(--seam)] overflow-y-auto px-2 py-2.5 text-[12.5px]">
      <div className="mb-2.5" data-no-drag>
        <SettingsSearch value={query} onChange={onQueryChange} />
      </div>
      {NAV_SECTIONS.map((section) => {
        const { icon: Icon, color } = SECTION_ICONS[section.id];
        const isActive = active === section.id;
        const matchCount = highlightedPages
          ? section.pages.filter((p) => highlightedPages.has(p)).length
          : 0;
        const dimmed = highlightedPages !== undefined && matchCount === 0;
        return (
          <button
            key={section.id}
            onClick={() => onSelect(section.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`w-full flex items-center gap-2.5 px-2 py-[5px] rounded-md text-left transition-[background-color,color,opacity] ${
              isActive
                ? 'bg-accent-primary/18 text-text-primary'
                : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary'
            } ${dimmed ? 'opacity-40' : ''}`}
          >
            <span
              className="w-[18px] h-[18px] rounded-[5px] grid place-items-center flex-none text-white"
              style={{ background: color }}
            >
              <Icon size={11} strokeWidth={2.25} />
            </span>
            <span className="flex-1 truncate">{section.label}</span>
            {matchCount > 0 && (
              <span className="text-[10px] tabular-nums px-1.5 rounded-full bg-yellow-400/20 text-text-primary">
                {matchCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
