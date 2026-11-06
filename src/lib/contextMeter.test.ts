import { describe, it, expect } from 'vitest';
import {
  contextWindowFor,
  fillPercent,
  formatTokens,
  levelFor,
  readContext,
  CLAUDE_1M_WINDOW,
  CLAUDE_WINDOW,
  type ContextUsage,
} from './contextMeter';

const u = (used: number, window: number | null = null): ContextUsage => ({ used_tokens: used, window_tokens: window, model: null });

describe('contextWindowFor', () => {
  it('uses the window the transcript states (Codex)', () => {
    expect(contextWindowFor('codex', u(1000, 272_000))).toBe(272_000);
  });
  it('defaults Claude to 200k', () => {
    expect(contextWindowFor('claude', u(1000))).toBe(CLAUDE_WINDOW);
  });
  it('treats a [1m] model alias as a 1M window', () => {
    expect(contextWindowFor('claude', u(1000), 'opus[1m]')).toBe(CLAUDE_1M_WINDOW);
    expect(contextWindowFor('claude', u(1000), 'claude-sonnet-4-5[1M]')).toBe(CLAUDE_1M_WINDOW);
  });
  it('infers 1M when usage already exceeds 200k', () => {
    expect(contextWindowFor('claude', u(250_000))).toBe(CLAUDE_1M_WINDOW);
  });
  it('returns null for agents with no known window', () => {
    expect(contextWindowFor('codex', u(1000))).toBeNull();
    expect(contextWindowFor('cursor', u(1000))).toBeNull();
  });
});

describe('fillPercent / levelFor', () => {
  it('rounds and clamps', () => {
    expect(fillPercent(124_000, 200_000)).toBe(62);
    expect(fillPercent(260_000, 200_000)).toBe(100);
    expect(fillPercent(5, 0)).toBe(0);
  });
  it('switches level at 75 and 90', () => {
    expect(levelFor(74)).toBe('ok');
    expect(levelFor(75)).toBe('warn');
    expect(levelFor(89)).toBe('warn');
    expect(levelFor(90)).toBe('crit');
  });
});

describe('formatTokens', () => {
  it('formats plain, thousands and millions', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});

describe('readContext', () => {
  it('hides when there is no usage or no window', () => {
    expect(readContext('claude', undefined)).toBeNull();
    expect(readContext('claude', u(0))).toBeNull();
    expect(readContext('cursor', u(1000))).toBeNull();
  });
  it('produces a full reading', () => {
    expect(readContext('claude', u(184_000))).toEqual({ used: 184_000, window: 200_000, percent: 92, level: 'crit' });
  });
});
