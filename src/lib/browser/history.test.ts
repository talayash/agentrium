import { describe, it, expect } from 'vitest';
import { emptyHistory, recordLoad, markPending, canGoBack, canGoForward } from './history';

const load = (urls: string[]) => urls.reduce(recordLoad, emptyHistory);

describe('browser history', () => {
  it('starts with nothing to go back or forward to', () => {
    expect(canGoBack(emptyHistory)).toBe(false);
    expect(canGoForward(emptyHistory)).toBe(false);
  });

  it('pushes new pages', () => {
    const h = load(['a', 'b', 'c']);
    expect(h.entries).toEqual(['a', 'b', 'c']);
    expect(h.index).toBe(2);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
  });

  it('ignores a reload of the current page', () => {
    const h = recordLoad(load(['a', 'b']), 'b');
    expect(h.entries).toEqual(['a', 'b']);
  });

  it('moves back and forward on pending loads', () => {
    let h = load(['a', 'b', 'c']);
    h = recordLoad(markPending(h, 'back'), 'b');
    expect(h.index).toBe(1);
    expect(canGoForward(h)).toBe(true);
    h = recordLoad(markPending(h, 'forward'), 'c');
    expect(h.index).toBe(2);
    expect(h.pending).toBeNull();
  });

  it('drops forward entries when navigating somewhere new', () => {
    let h = load(['a', 'b', 'c']);
    h = recordLoad(markPending(h, 'back'), 'b');
    h = recordLoad(h, 'd');
    expect(h.entries).toEqual(['a', 'b', 'd']);
    expect(canGoForward(h)).toBe(false);
  });

  it('treats a back press with nothing behind as a normal load', () => {
    const h = recordLoad(markPending(load(['a']), 'back'), 'b');
    expect(h.entries).toEqual(['a', 'b']);
  });
});
