import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  markTerminalActive, getLastOutputAt, clearTerminalActivity, getActiveTerminalIds,
} from './terminalActivity';

beforeEach(() => {
  // Wipe the module-level map between tests.
  clearTerminalActivity('a');
  clearTerminalActivity('b');
  clearTerminalActivity('c');
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('terminalActivity', () => {
  it('markTerminalActive stamps Date.now()', () => {
    const before = Date.now();
    markTerminalActive('a');
    const after = Date.now();
    const ts = getLastOutputAt('a');
    expect(ts).not.toBeUndefined();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  it('getLastOutputAt returns undefined for unknown ids', () => {
    expect(getLastOutputAt('never-marked')).toBeUndefined();
  });

  it('clearTerminalActivity removes a single entry', () => {
    markTerminalActive('a');
    markTerminalActive('b');
    clearTerminalActivity('a');
    expect(getLastOutputAt('a')).toBeUndefined();
    expect(getLastOutputAt('b')).toBeDefined();
  });

  it('getActiveTerminalIds returns only ids within the given window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));

    markTerminalActive('a');
    vi.advanceTimersByTime(1000);
    markTerminalActive('b');
    vi.advanceTimersByTime(3000); // a is now 4s old, b is 3s old
    markTerminalActive('c');

    expect(getActiveTerminalIds(2000).sort()).toEqual(['c']);
    expect(getActiveTerminalIds(4000).sort()).toEqual(['b', 'c']);
    expect(getActiveTerminalIds(10_000).sort()).toEqual(['a', 'b', 'c']);
  });

  it('markTerminalActive overwrites the timestamp on subsequent calls', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));

    markTerminalActive('a');
    const t1 = getLastOutputAt('a')!;
    vi.advanceTimersByTime(5000);
    markTerminalActive('a');
    const t2 = getLastOutputAt('a')!;

    expect(t2 - t1).toBeGreaterThanOrEqual(5000);
  });
});
