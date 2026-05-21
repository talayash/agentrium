import { useState, useMemo, lazy, Suspense, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { SettingsCategoryTree } from './SettingsCategoryTree';
import { SettingsSearch } from './SettingsSearch';
import { searchSettings, type CategoryId } from './index';

const pages: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  'appearance-behavior.appearance':       lazy(() => import('./categories/AppearancePage')),
  'appearance-behavior.notifications':    lazy(() => import('./categories/NotificationsPage')),
  'appearance-behavior.startup-session':  lazy(() => import('./categories/StartupSessionPage')),
  'appearance-behavior.keymap':           lazy(() => import('./categories/KeymapPage')),
  'editor.general':                       lazy(() => import('./categories/EditorGeneralPage')),
  'editor.font':                          lazy(() => import('./categories/EditorFontPage')),
  'terminal.appearance':                  lazy(() => import('./categories/TerminalAppearancePage')),
  'terminal.behavior':                    lazy(() => import('./categories/TerminalBehaviorPage')),
  'terminal.pastes':                      lazy(() => import('./categories/TerminalPastesPage')),
  'vcs.git':                              lazy(() => import('./categories/GitPage')),
  'vcs.changelists':                      lazy(() => import('./categories/ChangelistsPage')),
  'claude.defaults':                      lazy(() => import('./categories/ClaudeDefaultsPage')),
  'claude.updates':                       lazy(() => import('./categories/ClaudeUpdatesPage')),
  'tools.launchers':                      lazy(() => import('./categories/ToolsLaunchersPage')),
  'privacy-about.privacy':                lazy(() => import('./categories/PrivacyPage')),
  'privacy-about.about':                  lazy(() => import('./categories/AboutPage')),
};

export function SettingsWindow() {
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [active, setActive] = useState<CategoryId>({ group: 'appearance-behavior', page: 'appearance' });
  const [query, setQuery] = useState('');

  const highlightedPages = useMemo(() => {
    if (!query.trim()) return undefined;
    const matches = searchSettings(query);
    return new Set(matches.map((m) => `${m.category.group}.${m.category.page}`));
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  const key = `${active.group}.${active.page}`;
  const PageComponent = pages[key];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/55 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-elevation-0 border border-[var(--ij-divider-soft)] rounded-lg w-[92vw] max-w-[1100px] h-[80vh] max-h-[720px] grid grid-rows-[44px_1fr] overflow-hidden"
      >
        <div className="flex items-center justify-between px-3 bg-elevation-1 border-b border-[var(--ij-divider-soft)]">
          <div className="flex items-center gap-3">
            <span className="text-text-primary text-[13px] font-semibold">Settings</span>
            <SettingsSearch value={query} onChange={setQuery} />
          </div>
          <button
            onClick={closeSettings}
            className="p-1.5 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
            title="Close (Esc)"
            aria-label="Close settings"
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-[200px_1fr] overflow-hidden">
          <SettingsCategoryTree
            active={active}
            onSelect={setActive}
            highlightedPages={highlightedPages}
          />
          <div className="overflow-y-auto p-6">
            <Suspense fallback={<div className="text-text-tertiary text-[12px]">Loading…</div>}>
              {PageComponent ? <PageComponent /> : null}
            </Suspense>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
