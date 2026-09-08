import { afterEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalScrollbar } from './terminalScrollbar';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('tracks buffer changes, routes scrolling to its own terminal, and disposes listeners', () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const callbacks: (() => void)[] = [];
  const dispose = vi.fn();
  const subscribe = (fn: () => void) => { callbacks.push(fn); return { dispose }; };
  const active = { baseY: 100, viewportY: 50, type: 'normal' };
  const terminal = {
    rows: 20, buffer: { active, onBufferChange: subscribe },
    onScroll: subscribe, onResize: subscribe, onWriteParsed: subscribe,
    scrollLines: vi.fn(),
  };
  const container = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  container.append(viewport);
  const cleanup = attachTerminalScrollbar(container, terminal as unknown as Terminal, 'auto-hide');
  const track = container.querySelector('.terminal-scrollbar') as HTMLElement;
  expect(track.getAttribute('aria-valuenow')).toBe('50');
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
  expect(terminal.scrollLines).toHaveBeenCalledWith(-20);
  expect(track.classList.contains('is-visible')).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(track.classList.contains('is-visible')).toBe(true);
  active.viewportY = 100;
  // Native wheel scrolling does not emit xterm's public onScroll event.
  viewport.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(16);
  expect(track.getAttribute('aria-valuenow')).toBe('100');
  expect(track.classList.contains('is-visible')).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(track.classList.contains('is-visible')).toBe(false);
  active.baseY = 0;
  active.viewportY = 0;
  callbacks.forEach(fn => fn());
  vi.advanceTimersByTime(16);
  expect(track.hidden).toBe(true);
  active.baseY = 20;
  active.viewportY = 20;
  callbacks.forEach(fn => fn());
  vi.advanceTimersByTime(16);
  expect(track.hidden).toBe(false);
  expect(track.classList.contains('is-visible')).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(track.classList.contains('is-visible')).toBe(false);
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  container.append(screen);
  const wheel = vi.fn();
  screen.addEventListener('wheel', wheel);
  active.type = 'alternate';
  callbacks.forEach(fn => fn());
  vi.advanceTimersByTime(16);
  expect(track.hidden).toBe(true);
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
  expect(wheel).not.toHaveBeenCalled();
  expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
  active.type = 'normal';
  active.viewportY = 5;
  callbacks.forEach(fn => fn());
  vi.advanceTimersByTime(16);
  expect(track.hidden).toBe(false);
  expect(track.getAttribute('aria-valuenow')).toBe('5');
  screen.remove();
  cleanup();
  expect(container.querySelector('.terminal-scrollbar')).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(4);
});
