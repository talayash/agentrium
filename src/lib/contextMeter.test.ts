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

const u = (used: number, window: number | null = null, extra: Partial<ContextUsage> = {}): ContextUsage => ({
  used_tokens: used,
  window_tokens: window,
  model: null,
  configured_model: null,
  ...extra,
});

describe('contextWindowFor', () => {
  it('uses the window the transcript states (Codex)', () => {
    expect(contextWindowFor('codex', u(1000, 272_000))).toBe(272_000);
  });
  it('reports an unknown Claude window when nothing says 200k or 1M', () => {
    // A plain model can be 1M by plan default, so 200k is not a safe guess.
    expect(contextWindowFor('claude', u(1000))).toBe('unknown');
    expect(contextWindowFor('claude', u(74_000, null, { model: 'claude-sonnet-5-5', configured_model: 'sonnet' }))).toBe('unknown');
  });
  it('treats a [1m] configured model (arg, env or settings) as a 1M window', () => {
    expect(contextWindowFor('claude', u(1000, null, { configured_model: 'opus[1m]' }))).toBe(CLAUDE_1M_WINDOW);
    expect(contextWindowFor('claude', u(1000, null, { configured_model: 'claude-sonnet-4-5[1M]' }))).toBe(CLAUDE_1M_WINDOW);
  });
  it('treats a [1m] transcript model as a 1M window', () => {
    expect(contextWindowFor('claude', u(1000, null, { model: 'claude-sonnet-5-5[1m]' }))).toBe(CLAUDE_1M_WINDOW);
  });
  it('infers 1M when usage already exceeds 200k, or did earlier in the session', () => {
    expect(contextWindowFor('claude', u(250_000))).toBe(CLAUDE_1M_WINDOW);
    // after /compact the usage drops, but the window did not shrink
    expect(contextWindowFor('claude', u(40_000), { seenOver200k: true })).toBe(CLAUDE_1M_WINDOW);
  });
  it('honors the manual setting, except when usage proves 1M', () => {
    expect(contextWindowFor('claude', u(1000), { setting: '200k' })).toBe(CLAUDE_WINDOW);
    expect(contextWindowFor('claude', u(1000), { setting: '1m' })).toBe(CLAUDE_1M_WINDOW);
    expect(contextWindowFor('claude', u(1000, null, { configured_model: 'opus[1m]' }), { setting: '200k' })).toBe(CLAUDE_WINDOW);
    expect(contextWindowFor('claude', u(250_000), { setting: '200k' })).toBe(CLAUDE_1M_WINDOW);
    expect(contextWindowFor('claude', u(1000), { setting: 'auto' })).toBe('unknown');
  });
  it('ignores the Claude setting for other agents', () => {
    expect(contextWindowFor('codex', u(1000), { setting: '1m' })).toBeNull();
    expect(contextWindowFor('codex', u(1000, 272_000), { setting: '200k' })).toBe(272_000);
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
  it('produces a full reading when the window is known', () => {
    expect(readContext('claude', u(184_000), { setting: '200k' })).toEqual({ used: 184_000, window: 200_000, percent: 92, level: 'crit' });
  });
  it('issue #120: 74k on a 1M session reads 7%, not 37%', () => {
    const usage = u(74_600, null, { model: 'claude-sonnet-5-5', configured_model: 'sonnet[1m]' });
    expect(readContext('claude', usage)).toEqual({ used: 74_600, window: 1_000_000, percent: 7, level: 'ok' });
  });
  it('gives tokens only, with no percent or level, when the Claude window is unknown', () => {
    expect(readContext('claude', u(184_000))).toEqual({ used: 184_000, window: null, percent: null, level: null });
  });
});
