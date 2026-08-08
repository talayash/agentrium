// Palette matching helpers extracted from CommandPalette.tsx so they can be
// unit-tested in isolation and reused by any palette source in Phase 5.
//
// Semantics are preserved verbatim from the original inline implementations;
// the only intentional addition is empty-query handling in fuzzyMatch, which
// the CommandPalette caller previously guarded externally.

export interface PaletteUsage {
  count: number;
  lastUsedTs: number;
}

export interface FuzzyMatchResult {
  matches: boolean;
  score: number;
}

/**
 * Fuzzy match text against query. Exact-substring matches score highest
 * (100 - startIdx, so front matches beat middle matches). Character-by-
 * character fuzzy match falls back if no substring hit — consecutive
 * matches get a 3-point bonus, non-consecutive 1 point.
 * Empty query returns { matches: true, score: 0 }.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatchResult {
  // Empty query: everything matches with a neutral score, so callers can
  // safely feed unfiltered input through the same pipeline.
  if (query.length === 0) {
    return { matches: true, score: 0 };
  }

  const lower = text.toLowerCase();
  const q = query.toLowerCase();

  // Exact substring match (highest score)
  const subIdx = lower.indexOf(q);
  if (subIdx !== -1) {
    // Prefer matches at the start
    return { matches: true, score: 100 - subIdx };
  }

  // Character-by-character fuzzy match
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      qi++;
      // Bonus for consecutive matches
      score += lastMatchIdx === i - 1 ? 3 : 1;
      lastMatchIdx = i;
    }
  }
  if (qi === q.length) {
    return { matches: true, score };
  }
  return { matches: false, score: 0 };
}

/**
 * Frecency = frequency + recency. Small recency bump keeps recently-used
 * items near the top without letting a one-off click outrank a daily habit.
 * Returns 0 for undefined usage.
 */
export function frecencyScore(usage?: PaletteUsage): number {
  if (!usage) return 0;
  const age = Date.now() - usage.lastUsedTs;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const recency = age < HOUR ? 8 : age < DAY ? 4 : age < 7 * DAY ? 2 : 1;
  return usage.count + recency;
}
