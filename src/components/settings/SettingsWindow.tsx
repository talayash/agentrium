import { useState, useMemo, lazy, Suspense } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../ui/Modal';
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
  'editor.language-servers':              lazy(() => import('./categories/LanguageServersPage')),
  'terminal.appearance':                  lazy(() => import('./categories/TerminalAppearancePage')),
  'terminal.behavior':                    lazy(() => import('./categories/TerminalBehaviorPage')),
  'terminal.pastes':                      lazy(() => import('./categories/TerminalPastesPage')),
  'vcs.git':                              lazy(() => import('./categories/GitPage')),
  'vcs.changelists':                      lazy(() => import('./categories/ChangelistsPage')),
  'claude.agents-keys':                   lazy(() => import('./categories/AgentsKeysPage')),
  'claude.defaults':                      lazy(() => import('./categories/ClaudeDefaultsPage')),
  'claude.updates':                       lazy(() => import('./categories/ClaudeUpdatesPage')),
  'tools.launchers':                      lazy(() => import('./categories/ToolsLaunchersPage')),
  'tools.preview':                        lazy(() => import('./categories/PreviewPage')),
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

  const key = `${active.group}.${active.page}`;
  const PageComponent = pages[key];

  return (
    <Modal
      onClose={closeSettings}
      closeOn="click"
      panelClassName="grid grid-rows-[44px_1fr] w-[92vw] max-w-[1100px] h-[80vh] max-h-[720px]"
    >
      <div className="flex items-center justify-between px-3 border-b border-[var(--seam)]">
        <div className="flex items-center gap-3">
          <span className="text-text-primary text-[13px] font-semibold">Settings</span>
          <SettingsSearch value={query} onChange={setQuery} />
        </div>
        <button
          onClick={closeSettings}
          className="p-1.5 rounded hover:bg-fill-hover text-text-tertiary transition-colors"
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
    </Modal>
  );
}
