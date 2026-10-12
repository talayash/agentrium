import { beforeEach, expect, it, vi } from 'vitest';
import { openLearnFor } from './openLearnFor';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

beforeEach(() => vi.restoreAllMocks());

it('activates the finished terminal before opening Learn', () => {
  const calls: string[] = [];
  const setActive = vi.fn((id: string) => { calls.push(`active:${id}`); });
  const openLearn = vi.fn(() => { calls.push('open'); });
  vi.spyOn(useTerminalStore, 'getState').mockReturnValue({ terminals: new Map([['t2', {}]]), setActiveTerminal: setActive } as never);
  vi.spyOn(useAppStore, 'getState').mockReturnValue({ openLearn } as never);
  openLearnFor('t2');
  expect(calls).toEqual(['active:t2', 'open']);
});

it('only opens Learn when the terminal is not in this window', () => {
  const setActive = vi.fn();
  const openLearn = vi.fn();
  vi.spyOn(useTerminalStore, 'getState').mockReturnValue({ terminals: new Map(), setActiveTerminal: setActive } as never);
  vi.spyOn(useAppStore, 'getState').mockReturnValue({ openLearn } as never);
  openLearnFor('gone');
  expect(setActive).not.toHaveBeenCalled();
  expect(openLearn).toHaveBeenCalledOnce();
});
