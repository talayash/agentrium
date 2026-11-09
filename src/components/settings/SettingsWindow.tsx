import { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { X } from 'lucide-react';
import { useDragControls } from 'framer-motion';
import { useAppStore } from '../../store/appStore';
import { Modal } from '../ui/Modal';
import { SettingsNav } from './SettingsNav';
import { PageHeaderModeContext, PageHighlightContext } from './SettingRow';
import { NAV_SECTIONS, pageKey, searchSettings, sectionForPage, type NavSectionId } from './index';

// Loaders, not just lazy components: each page module registers its searchable
// settings at import time, so search only knows pages whose module has loaded.
const loaders: Record<string, () => Promise<{ default: React.ComponentType }>> = {
  'appearance-behavior.appearance':       () => import('./categories/AppearancePage'),
  'appearance-behavior.notifications':    () => import('./categories/NotificationsPage'),
  'appearance-behavior.startup-session':  () => import('./categories/StartupSessionPage'),
  'appearance-behavior.keymap':           () => import('./categories/KeymapPage'),
  'editor.general':                       () => import('./categories/EditorGeneralPage'),
  'editor.font':                          () => import('./categories/EditorFontPage'),
  'editor.language-servers':              () => import('./categories/LanguageServersPage'),
  'terminal.appearance':                  () => import('./categories/TerminalAppearancePage'),
  'terminal.behavior':                    () => import('./categories/TerminalBehaviorPage'),
  'terminal.pastes':                      () => import('./categories/TerminalPastesPage'),
  'vcs.git':                              () => import('./categories/GitPage'),
  'vcs.changelists':                      () => import('./categories/ChangelistsPage'),
  'claude.agents-keys':                   () => import('./categories/AgentsKeysPage'),
  'claude.defaults':                      () => import('./categories/ClaudeDefaultsPage'),
  'claude.learn':                         () => import('./categories/LearnPage'),
  'claude.updates':                       () => import('./categories/ClaudeUpdatesPage'),
  'tools.launchers':                      () => import('./categories/ToolsLaunchersPage'),
  'tools.preview':                        () => import('./categories/PreviewPage'),
  'privacy-about.privacy':                () => import('./categories/PrivacyPage'),
  'privacy-about.about':                  () => import('./categories/AboutPage'),
};

const pages = Object.fromEntries(
  Object.entries(loaders).map(([key, load]) => [key, lazy(load)]),
);

export function SettingsWindow() {
  const dragControls = useDragControls();
  const closeSettings = useAppStore((s) => s.closeSettings);
  const [active, setActive] = useState<NavSectionId>('general');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load every page module up front (cheap, already code-split) so the search
  // index is complete; re-run the search once they have all registered.
  const [indexReady, setIndexReady] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all(Object.values(loaders).map((load) => load()))
      .then(() => { if (alive) setIndexReady(true); })
      // A failed chunk shows up again (and is reported) when its page renders.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const highlightedPages = useMemo(() => {
    if (!query.trim()) return undefined;
    return new Set(searchSettings(query).map((m) => pageKey(m.category)));
    // indexReady: recompute once late-loading pages have registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, indexReady]);

  // Search navigates instead of only dimming: on each new query, stay in the
  // current section if it has a hit, else jump to the first section that does,
  // then scroll the first matching page into view. Runs only when the query's
  // results change, so clicking another section mid-search is not overridden.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!highlightedPages || highlightedPages.size === 0) return;
    const inCurrent = NAV_SECTIONS.find((s) => s.id === activeRef.current)!
      .pages.find((p) => highlightedPages.has(p));
    const target = inCurrent
      ?? NAV_SECTIONS.flatMap((s) => s.pages).find((p) => highlightedPages.has(p))!;
    const targetSection = sectionForPage(target)!;
    if (targetSection !== activeRef.current) setActive(targetSection);

    // Pages are lazy: retry for a few frames until the target has mounted.
    let frames = 0;
    let raf = 0;
    const tryScroll = () => {
      const el = scrollRef.current?.querySelector(`[data-page-key="${target}"]`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else if (frames++ < 30) raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [highlightedPages]);

  const section = NAV_SECTIONS.find((s) => s.id === active)!;
  const headerMode = section.pages.length > 1 ? 'sub' : 'hidden';

  return (
    <Modal
      onClose={closeSettings}
      closeOn="click"
      dragControls={dragControls}
      panelClassName="grid grid-rows-[40px_1fr] w-[92vw] max-w-[1040px] h-[80vh] max-h-[720px]"
    >
      <div
        className="flex items-center justify-between px-3 border-b border-[var(--seam)] cursor-move select-none touch-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || !(event.target instanceof Element)) return;
          if (event.target.closest('button, input, [data-no-drag]')) return;
          dragControls.start(event);
        }}
      >
        <span className="text-text-primary text-[13px] font-semibold">Settings</span>
        <button
          onClick={closeSettings}
          className="p-1.5 rounded hover:bg-fill-hover text-text-tertiary transition-colors"
          title="Close (Esc)"
          aria-label="Close settings"
        >
          <X size={14} />
        </button>
      </div>

      <div className="grid grid-cols-[212px_1fr] overflow-hidden">
        <SettingsNav
          active={active}
          onSelect={setActive}
          query={query}
          onQueryChange={setQuery}
          highlightedPages={highlightedPages}
        />
        {/* Keyed by section so switching sections starts at the top. */}
        <div key={section.id} ref={scrollRef} className="overflow-y-auto px-7 py-6">
          <header className="mb-5">
            <h2 className="text-text-primary text-[length:var(--text-h2)] font-semibold">{section.label}</h2>
            <p className="text-text-tertiary text-[12px] mt-1">{section.description}</p>
          </header>
          <Suspense fallback={<div className="text-text-tertiary text-[12px]">Loading…</div>}>
            <PageHeaderModeContext.Provider value={headerMode}>
              {section.pages.map((key) => {
                const PageComponent = pages[key];
                if (!PageComponent) return null;
                return (
                  <div key={key} data-page-key={key} className="scroll-mt-4 [&+&]:mt-8">
                    <PageHighlightContext.Provider value={highlightedPages?.has(key) ?? false}>
                      <PageComponent />
                    </PageHighlightContext.Provider>
                  </div>
                );
              })}
            </PageHeaderModeContext.Provider>
          </Suspense>
        </div>
      </div>
    </Modal>
  );
}
