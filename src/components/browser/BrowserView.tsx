import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Lock,
  Unlock,
  Search,
  Star,
  Plus,
  X,
  Globe,
  AlertTriangle,
  Columns,
  Loader2,
  Info,
  Crosshair,
} from 'lucide-react';
import { useBrowserStore, activeTab, type BrowserTab } from '../../store/browserStore';
import { canGoBack, canGoForward } from '../../lib/browser/history';
import { hostOf, isSecure } from '../../lib/browser/address';
import {
  cancelPick,
  closeTab,
  goBack,
  goForward,
  navigateTab,
  placeTab,
  reloadTab,
  setPageSlot,
  showOnly,
  startPick,
} from '../../lib/browser/controller';
import { useOcclusion } from './useOcclusion';
import { Tooltip } from '../ui/Tooltip';
import { ProgressStripe } from '../ui/ProgressStripe';
import { Button } from '../ui/Button';

const iconBtn =
  'w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-fill-hover hover:text-text-primary active:scale-95 transition-[background-color,color,transform] duration-100 disabled:opacity-35 disabled:pointer-events-none';

// The element picker is the one toolbar control that talks to the agent, so it
// carries the accent instead of the neutral iconBtn look.
const pickBtn =
  'relative w-7 h-7 flex items-center justify-center rounded-md bg-gradient-to-br active:scale-95 transition-[background-color,color,box-shadow,transform] duration-100 disabled:opacity-35 disabled:pointer-events-none';
const pickBtnIdle =
  'from-accent-primary/18 to-accent-secondary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:from-accent-primary/30 hover:to-accent-secondary/30 hover:ring-accent-primary/50';
const pickBtnActive = 'from-accent-primary to-accent-secondary text-white shadow-glow-sm';

function tabLabel(tab: BrowserTab): string {
  if (!tab.url) return 'New tab';
  return tab.title || hostOf(tab.url);
}

interface Props {
  /** True while the terminal/browser divider is being dragged. */
  resizing: boolean;
}

export function BrowserView({ resizing }: Props) {
  const tab = useBrowserStore(activeTab);
  const pickingTabId = useBrowserStore((s) => s.pickingTabId);

  // Esc while the app (not the page) has focus also cancels the picker.
  useEffect(() => {
    if (!pickingTabId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') cancelPick(pickingTabId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickingTabId]);

  return (
    <div className="h-full flex flex-col min-w-0 bg-elevation-0" data-testid="browser-view">
      <TabStrip />
      <Toolbar tab={tab} />
      <BookmarksBar />
      {tab && pickingTabId === tab.id && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-1.5 bg-elevation-1 border-b border-seam text-[12px] text-text-secondary shrink-0"
        >
          <Crosshair size={13} className="text-accent-primary shrink-0" />
          <span className="flex-1 min-w-0 truncate">Click an element on the page. Esc cancels.</span>
        </div>
      )}
      {tab?.notice && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-elevation-1 border-b border-seam text-[12px] text-text-secondary shrink-0">
          <Info size={13} className="text-accent-primary shrink-0" />
          <span className="flex-1 min-w-0 truncate">{tab.notice}</span>
          <button
            type="button"
            className={iconBtn}
            aria-label="Dismiss"
            onClick={() => useBrowserStore.getState().patchTab(tab.id, { notice: null })}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <PageArea tab={tab} resizing={resizing} />
    </div>
  );
}

function TabStrip() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const layout = useBrowserStore((s) => s.layout);
  const setLayout = useBrowserStore((s) => s.setLayout);
  const activate = useBrowserStore((s) => s.activateTab);
  const addTab = useBrowserStore((s) => s.addTab);

  return (
    <div className="flex items-center gap-0.5 h-[34px] px-2 shrink-0 overflow-hidden" role="tablist" aria-label="Browser tabs">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const label = tabLabel(t);
        return (
          <div
            key={t.id}
            className={`group flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-lg min-w-[72px] flex-[0_1_190px] ${
              active ? 'bg-elevation-2 text-text-primary' : 'text-text-secondary hover:bg-fill-hover'
            }`}
          >
            {t.loading ? (
              <Loader2 size={13} className="animate-spin text-accent-primary shrink-0" />
            ) : t.error ? (
              <AlertTriangle size={13} className="text-error shrink-0" />
            ) : (
              <Globe size={13} className="shrink-0" />
            )}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={t.url || 'New tab'}
              onClick={() => activate(t.id)}
              className="flex-1 min-w-0 text-left text-[12px] font-medium truncate"
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => closeTab(t.id)}
              className={`w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:bg-fill-hover hover:text-text-primary shrink-0 ${
                active ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </div>
        );
      })}
      <Tooltip label="New tab">
        <button type="button" className={`${iconBtn} shrink-0`} aria-label="New tab" onClick={() => addTab()}>
          <Plus size={14} />
        </button>
      </Tooltip>
      <div className="flex-1" />
      <Tooltip label={layout === 'split' ? 'Browser full width' : 'Split with terminal'}>
        <button
          type="button"
          aria-label={layout === 'split' ? 'Browser full width' : 'Split with terminal'}
          aria-pressed={layout === 'split'}
          onClick={() => setLayout(layout === 'split' ? 'full' : 'split')}
          className={`${iconBtn} shrink-0 ${layout === 'split' ? 'bg-fill-active text-text-primary' : ''}`}
        >
          <Columns size={15} />
        </button>
      </Tooltip>
    </div>
  );
}

function Toolbar({ tab }: { tab: BrowserTab | undefined }) {
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const toggleBookmark = useBrowserStore((s) => s.toggleBookmark);
  const picking = useBrowserStore((s) => !!tab && s.pickingTabId === tab.id);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const url = tab?.url ?? '';
  // Follow the page while the user isn't typing; switching tabs always resets.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(url);
  }, [url]);
  useEffect(() => {
    setDraft(url);
    if (tab && !tab.url) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id]);

  const bookmarked = !!url && bookmarks.some((b) => b.url === url);
  const blank = !url;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!tab) return;
    if (e.key === 'Enter') {
      void navigateTab(tab.id, draft);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setDraft(url);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative flex items-center gap-1 h-10 px-2 bg-elevation-2 border-t border-seam shrink-0">
      <Tooltip label="Back">
        <button
          type="button"
          className={iconBtn}
          aria-label="Back"
          disabled={!tab || !canGoBack(tab.history)}
          onClick={() => tab && goBack(tab.id)}
        >
          <ArrowLeft size={15} />
        </button>
      </Tooltip>
      <Tooltip label="Forward">
        <button
          type="button"
          className={iconBtn}
          aria-label="Forward"
          disabled={!tab || !canGoForward(tab.history)}
          onClick={() => tab && goForward(tab.id)}
        >
          <ArrowRight size={15} />
        </button>
      </Tooltip>
      <Tooltip label="Reload">
        <button
          type="button"
          className={iconBtn}
          aria-label="Reload"
          disabled={!tab || blank}
          onClick={() => tab && reloadTab(tab.id)}
        >
          <RotateCw size={14} className={tab?.loading ? 'animate-spin' : ''} />
        </button>
      </Tooltip>
      <Tooltip label={picking ? 'Cancel element picking' : 'Pick an element to send to the agent'}>
        <button
          type="button"
          className={`${pickBtn} ${picking ? pickBtnActive : pickBtnIdle}`}
          aria-label="Pick an element to send to the agent"
          aria-pressed={picking}
          disabled={!tab || !tab.hasWebview || !!tab.error}
          onClick={() => tab && (picking ? cancelPick(tab.id) : startPick(tab.id))}
        >
          {picking && (
            <span
              aria-hidden
              className="absolute inset-0 rounded-md ring-2 ring-accent-primary/60 animate-ping pointer-events-none"
            />
          )}
          <Crosshair size={15} strokeWidth={2.25} className="relative" />
        </button>
      </Tooltip>

      <label className="flex-1 min-w-0 flex items-center gap-2 h-[30px] mx-1 px-2.5 rounded-full bg-elevation-0 border border-seam focus-within:border-accent-primary/60">
        <span className="sr-only">Address</span>
        {blank ? (
          <Search size={13} className="text-text-tertiary shrink-0" />
        ) : isSecure(url) ? (
          <Lock size={13} className="text-text-tertiary shrink-0" aria-label="Secure connection" />
        ) : (
          <Unlock size={13} className="text-text-tertiary shrink-0" aria-label="Not secure" />
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(url)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Type a URL or search…"
          className="flex-1 min-w-0 bg-transparent outline-none focus-visible:outline-none text-[12.5px] text-text-primary placeholder:text-text-tertiary"
        />
      </label>

      <Tooltip label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}>
        <button
          type="button"
          className={iconBtn}
          aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          aria-pressed={bookmarked}
          disabled={blank}
          onClick={() => tab && toggleBookmark({ url, title: tab.title || hostOf(url) })}
        >
          <Star
            size={15}
            className={bookmarked ? 'text-accent-primary' : ''}
            fill={bookmarked ? 'currentColor' : 'none'}
          />
        </button>
      </Tooltip>

      <ProgressStripe hidden={!tab?.loading} className="absolute left-0 right-0 bottom-0" />
    </div>
  );
}

function BookmarksBar() {
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  const removeBookmark = useBrowserStore((s) => s.removeBookmark);
  const tab = useBrowserStore(activeTab);

  return (
    <div
      className="flex items-center gap-0.5 h-[30px] px-2 bg-elevation-2 border-b border-seam-strong shrink-0 overflow-x-auto"
      aria-label="Bookmarks"
    >
      {bookmarks.length === 0 ? (
        <span className="px-2 text-[11.5px] text-text-tertiary truncate">
          No bookmarks yet. Click the star to save a page here.
        </span>
      ) : (
        bookmarks.map((b) => (
          <div
            key={b.url}
            className="group flex items-center h-[22px] rounded-md text-text-secondary hover:bg-fill-hover hover:text-text-primary focus-within:bg-fill-hover max-w-[200px] shrink-0"
          >
            <button
              type="button"
              title={`${b.url}\nMiddle-click to remove`}
              onClick={() => tab && void navigateTab(tab.id, b.url)}
              onAuxClick={(e) => {
                if (e.button === 1) removeBookmark(b.url);
              }}
              className="flex items-center gap-1.5 h-full pl-2 pr-1 min-w-0 text-[11.5px] font-medium"
            >
              <Globe size={12} className="shrink-0" />
              <span className="truncate">{b.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove bookmark ${b.title}`}
              title="Remove bookmark"
              onClick={() => removeBookmark(b.url)}
              className="w-4 h-4 mr-1 flex items-center justify-center rounded shrink-0 text-text-tertiary hover:text-text-primary hover:bg-fill-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              data-testid="bookmark-remove"
            >
              <X size={11} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function PageArea({ tab, resizing }: { tab: BrowserTab | undefined; resizing: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const occluded = useOcclusion(slotRef);
  const tabs = useBrowserStore((s) => s.tabs);

  const pageVisible = !!tab && tab.hasWebview && !tab.error && !occluded && !resizing;
  const visibleId = pageVisible ? tab.id : null;

  useLayoutEffect(() => {
    setPageSlot(slotRef.current);
    return () => {
      setPageSlot(null);
      // Browser closed or unmounted: no webview may stay on screen.
      showOnly(null);
    };
  }, []);

  // Place before showing so a tab never flashes at a stale position.
  useLayoutEffect(() => {
    if (visibleId) placeTab(visibleId);
    showOnly(visibleId);
  }, [visibleId, tabs]);

  useEffect(() => {
    const el = slotRef.current;
    if (!el || !visibleId) return;
    const place = () => placeTab(visibleId);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [visibleId]);

  return (
    <div className="flex-1 min-h-0 relative">
      <div ref={slotRef} className="absolute inset-0" data-testid="browser-page-slot" />
      {tab && !tab.url && <NewTabPage tabId={tab.id} />}
      {tab?.error && <LoadError tab={tab} />}
      {tab && tab.url && !tab.error && !pageVisible && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-tertiary">
          {resizing || occluded ? 'Page hidden while this is open' : tab.loading ? 'Loading…' : ''}
        </div>
      )}
    </div>
  );
}

function NewTabPage({ tabId }: { tabId: string }) {
  const bookmarks = useBrowserStore((s) => s.bookmarks);
  return (
    <div className="absolute inset-0 overflow-auto flex flex-col items-center justify-center gap-5 p-6">
      <div className="w-[52px] h-[52px] flex items-center justify-center rounded-2xl bg-accent-primary/15 text-accent-primary">
        <Globe size={26} strokeWidth={1.7} />
      </div>
      <div className="text-center">
        <h2 className="text-[17px] font-semibold text-text-primary">New tab</h2>
        <p className="mt-1 text-[12.5px] text-text-secondary">
          Type a URL or search in the address bar{bookmarks.length ? ', or open a bookmark.' : '.'}
        </p>
      </div>
      {bookmarks.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2.5 max-w-[560px]">
          {bookmarks.map((b) => (
            <button
              key={b.url}
              type="button"
              onClick={() => void navigateTab(tabId, b.url)}
              className="w-40 p-3.5 rounded-xl border border-seam-strong bg-elevation-2 hover:bg-elevation-3 text-left flex flex-col gap-1.5"
            >
              <span className="text-[12.5px] font-semibold text-text-primary truncate w-full">{b.title}</span>
              <span className="text-[11px] font-mono text-text-tertiary truncate w-full">{hostOf(b.url)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LoadError({ tab }: { tab: BrowserTab }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div role="alert" className="w-[420px] max-w-full p-6 rounded-xl bg-elevation-2 border border-seam-strong flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5">
          <AlertTriangle size={20} className="text-error shrink-0" />
          <h2 className="text-[15px] font-semibold text-text-primary">This page couldn't load</h2>
        </div>
        <p className="text-[12.5px] text-text-secondary leading-relaxed">
          <span className="font-mono text-text-primary">{hostOf(tab.url)}</span>: {tab.error}
        </p>
        <div className="flex gap-2 mt-1.5">
          <Button variant="primary" size="sm" onClick={() => reloadTab(tab.id)}>
            Retry
          </Button>
          {canGoBack(tab.history) && (
            <Button variant="ghost" size="sm" onClick={() => goBack(tab.id)}>
              Go back
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
