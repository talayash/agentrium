import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('../../lib/browser/controller', () => ({
  cancelPick: vi.fn(),
  closeTab: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  navigateTab: vi.fn(),
  placeTab: vi.fn(),
  reloadTab: vi.fn(),
  setPageSlot: vi.fn(),
  showOnly: vi.fn(),
  startPick: vi.fn(),
}));
vi.mock('./useOcclusion', () => ({ useOcclusion: () => false }));

import { BrowserView } from './BrowserView';
import { cancelPick, startPick } from '../../lib/browser/controller';
import { useBrowserStore } from '../../store/browserStore';
import { emptyHistory } from '../../lib/browser/history';

const pickLabel = 'Pick an element to send to the agent';

afterEach(cleanup);

beforeEach(() => {
  useBrowserStore.setState({
    open: true,
    tabs: [{ id: 'a', url: 'https://example.com/', title: 'Example', loading: false, error: null, notice: null, hasWebview: true, history: emptyHistory }],
    activeTabId: 'a',
    pickingTabId: null,
    bookmarks: [],
  });
});

describe('BrowserView element picker', () => {
  it('arms the picker from the toolbar', () => {
    render(<BrowserView resizing={false} />);
    const btn = screen.getByRole('button', { name: pickLabel });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(startPick).toHaveBeenCalledWith('a');
  });

  it('shows the armed state and cancels on a second click or Esc', () => {
    useBrowserStore.setState({ pickingTabId: 'a' });
    render(<BrowserView resizing={false} />);
    const btn = screen.getByRole('button', { name: pickLabel });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Click an element on the page. Esc cancels.')).toBeTruthy();
    fireEvent.click(btn);
    expect(cancelPick).toHaveBeenCalledWith('a');
    vi.mocked(cancelPick).mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelPick).toHaveBeenCalledWith('a');
  });

  it('is disabled before the tab has a page', () => {
    useBrowserStore.setState({
      tabs: [{ id: 'a', url: '', title: '', loading: false, error: null, notice: null, hasWebview: false, history: emptyHistory }],
    });
    render(<BrowserView resizing={false} />);
    expect((screen.getByRole('button', { name: pickLabel }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Click an element on the page. Esc cancels.')).toBeNull();
  });
});
