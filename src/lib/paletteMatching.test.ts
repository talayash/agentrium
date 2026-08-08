import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frecencyScore, fuzzyMatch } from './paletteMatching';

describe('fuzzyMatch', () => {
  it('scores an exact substring at the start near 100', () => {
    // Substring at index 0 → 100 - 0 = 100.
    expect(fuzzyMatch('Toggle Sidebar', 'toggle')).toEqual({
      matches: true,
      score: 100,
    });
  });

  it('scores an exact substring in the middle lower than the same substring at the start', () => {
    // Same needle in both haystacks, positioned differently. The 100 - startIdx
    // rule means the earlier match wins by exactly the offset difference.
    const start = fuzzyMatch('toggle sidebar', 'toggle');
    const middle = fuzzyMatch('Sidebar toggle', 'toggle');
    expect(start.score).toBeGreaterThan(middle.score);
    expect(start).toEqual({ matches: true, score: 100 });
    expect(middle).toEqual({ matches: true, score: 100 - 'Sidebar '.length });
  });

  it('falls back to character-by-character fuzzy matching when no substring hit', () => {
    // 'tgl' has no substring in 'Toggle Sidebar' but the chars appear in order.
    // T(1) o... g(consecutive? no → 1) ... l(consecutive? no → 1) = 3.
    const result = fuzzyMatch('Toggle Sidebar', 'tgl');
    expect(result.matches).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    // Substring scores are triple-digit; fuzzy stays in single/low double.
    expect(result.score).toBeLessThan(100);
  });

  it('returns matches:false when the query characters are not all present in order', () => {
    expect(fuzzyMatch('Toggle Sidebar', 'zzz')).toEqual({ matches: false, score: 0 });
  });

  it('treats an empty query as a match with score 0', () => {
    // Added for Phase 5 — lets callers pipe unfiltered input through the same
    // scoring path instead of guarding externally.
    expect(fuzzyMatch('anything', '')).toEqual({ matches: true, score: 0 });
  });

  it('is case-insensitive for both text and query', () => {
    expect(fuzzyMatch('TOGGLE SIDEBAR', 'toggle').matches).toBe(true);
    expect(fuzzyMatch('toggle sidebar', 'TOGGLE').matches).toBe(true);
  });

  it('rewards consecutive fuzzy matches over scattered ones', () => {
    // 'abc' consecutive: a(1)+b(3)+c(3) = 7.
    // 'abc' scattered by unrelated letters: a(1)+b(1)+c(1) = 3.
    const consecutive = fuzzyMatch('xabcy', 'abc');
    const scattered = fuzzyMatch('axbxc', 'abc');
    expect(consecutive.matches).toBe(true);
    expect(scattered.matches).toBe(true);
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });
});

describe('frecencyScore', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when usage is undefined', () => {
    expect(frecencyScore(undefined)).toBe(0);
  });

  it('adds an 8-point recency bump for usage within the last hour', () => {
    // 10 minutes ago.
    expect(frecencyScore({ count: 3, lastUsedTs: NOW - 10 * 60 * 1000 })).toBe(3 + 8);
  });

  it('adds a 4-point recency bump for usage within the last day', () => {
    // 5 hours ago.
    expect(frecencyScore({ count: 2, lastUsedTs: NOW - 5 * 3_600_000 })).toBe(2 + 4);
  });

  it('adds a 2-point recency bump for usage within the last week', () => {
    // 3 days ago.
    expect(frecencyScore({ count: 5, lastUsedTs: NOW - 3 * 24 * 3_600_000 })).toBe(5 + 2);
  });

  it('adds a 1-point recency bump for usage older than a week', () => {
    // 30 days ago.
    expect(frecencyScore({ count: 10, lastUsedTs: NOW - 30 * 24 * 3_600_000 })).toBe(10 + 1);
  });
});
