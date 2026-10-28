import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore, activeTab, clampSplit, MIN_TERMINAL_PX, MIN_BROWSER_PX } from './browserStore';

const s = () => useBrowserStore.getState();

beforeEach(() => {
  useBrowserStore.setState({ open: false, layout: 'full', splitPx: 480, tabs: [], activeTabId: null, bookmarks: [] });
});

describe('browserStore', () => {
  it('defaults to the terminal + browser split layout', () => {
    expect(useBrowserStore.getInitialState().layout).toBe('split');
  });

  it('opening with no tabs creates an empty New tab', () => {
    s().setOpen(true);
    expect(s().open).toBe(true);
    expect(s().tabs).toHaveLength(1);
    expect(activeTab(s())?.url).toBe('');
  });

  it('reopening keeps existing tabs', () => {
    s().setOpen(true);
    const id = s().activeTabId;
    s().toggleOpen();
    s().toggleOpen();
    expect(s().tabs).toHaveLength(1);
    expect(s().activeTabId).toBe(id);
  });

  it('closing the active tab activates its neighbour', () => {
    const a = s().addTab();
    const b = s().addTab();
    const c = s().addTab();
    s().activateTab(b);
    s().removeTab(b);
    expect(s().activeTabId).toBe(c);
    s().removeTab(c);
    expect(s().activeTabId).toBe(a);
  });

  it('closing the last tab leaves a fresh New tab', () => {
    const a = s().addTab('https://example.com');
    s().removeTab(a);
    expect(s().tabs).toHaveLength(1);
    expect(s().tabs[0].id).not.toBe(a);
    expect(s().tabs[0].url).toBe('');
  });

  it('applies native load events to the matching tab', () => {
    const a = s().addTab();
    const b = s().addTab();
    s().applyEvent({ kind: 'loadStarted', id: a, url: 'https://example.com/' });
    expect(s().tabs.find((t) => t.id === a)?.loading).toBe(true);
    expect(s().tabs.find((t) => t.id === b)?.loading).toBe(false);

    s().applyEvent({ kind: 'titleChanged', id: a, title: 'Example' });
    s().applyEvent({ kind: 'loadFinished', id: a, url: 'https://example.com/' });
    const tab = s().tabs.find((t) => t.id === a)!;
    expect(tab).toMatchObject({ loading: false, title: 'Example', error: null });
    expect(tab.history.entries).toEqual(['https://example.com/']);
  });

  it('keeps a load failure visible after the finished event', () => {
    const a = s().addTab();
    s().applyEvent({ kind: 'loadStarted', id: a, url: 'http://localhost:3000/' });
    s().applyEvent({ kind: 'loadFailed', id: a, url: 'http://localhost:3000/', error: 'The site refused the connection.' });
    s().applyEvent({ kind: 'loadFinished', id: a, url: 'http://localhost:3000/' });
    expect(s().tabs[0].error).toBe('The site refused the connection.');
    s().applyEvent({ kind: 'loadStarted', id: a, url: 'http://localhost:3000/' });
    expect(s().tabs[0].error).toBeNull();
  });

  it('shows blocked navigations as a tab notice', () => {
    const a = s().addTab();
    s().applyEvent({ kind: 'blocked', id: a, url: 'file:///x', reason: 'Only http and https pages can open in the browser.' });
    expect(s().tabs[0].notice).toMatch(/Only http/);
  });

  it('toggles bookmarks by url', () => {
    s().toggleBookmark({ url: 'https://example.com/', title: 'Example' });
    expect(s().bookmarks).toHaveLength(1);
    s().toggleBookmark({ url: 'https://example.com/', title: 'Renamed' });
    expect(s().bookmarks).toHaveLength(0);
  });

  it('clamps the split so both panes keep their minimum width', () => {
    expect(clampSplit(10, 1000)).toBe(MIN_TERMINAL_PX);
    expect(clampSplit(990, 1000)).toBe(1000 - MIN_BROWSER_PX);
    expect(clampSplit(500)).toBe(500);
    s().setSplitPx(5000, 1200);
    expect(s().splitPx).toBe(1200 - MIN_BROWSER_PX);
  });
});
