import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// jsdom has no ResizeObserver; layout sizes aren't under test here.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

vi.mock('./BrowserView', () => ({ BrowserView: () => <div data-testid="browser-view" /> }));

import { BrowserWorkspace } from './BrowserWorkspace';
import { useBrowserStore } from '../../store/browserStore';

function renderWorkspace() {
  render(
    <BrowserWorkspace>
      <div data-testid="terminals" />
    </BrowserWorkspace>,
  );
  return screen.getByTestId('terminals').parentElement as HTMLElement;
}

afterEach(cleanup);

beforeEach(() => {
  useBrowserStore.setState({ open: false, layout: 'split', splitPx: 480, tabs: [], activeTabId: null });
});

describe('BrowserWorkspace', () => {
  it('shows only the terminals while the browser is closed', () => {
    const terminals = renderWorkspace();
    expect(terminals.className).toContain('flex-1');
    expect(screen.queryByTestId('browser-view')).toBeNull();
    expect(screen.queryByTestId('browser-split-handle')).toBeNull();
  });

  it('puts terminals and browser side by side in split layout', () => {
    useBrowserStore.setState({ open: true });
    const terminals = renderWorkspace();
    expect(terminals.style.width).toBe('480px');
    expect(screen.getByTestId('browser-split-handle')).toBeTruthy();
    expect(screen.getByTestId('browser-view')).toBeTruthy();
    expect(terminals.inert).toBe(false);
  });

  it('covers the terminals without re-laying them out in full layout', () => {
    useBrowserStore.setState({ open: true, layout: 'full' });
    const terminals = renderWorkspace();
    // Same box as with the browser closed, so the PTY is never resized.
    expect(terminals.className).toContain('flex-1');
    expect(terminals.style.width).toBe('');
    expect(terminals.inert).toBe(true);
    expect(terminals.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByTestId('browser-split-handle')).toBeNull();
  });
});
