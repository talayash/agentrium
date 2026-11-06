import type { AgentKind } from './agents';

/** Wire shape of `get_context_usage` (Rust `context_usage::ContextUsage`). */
export interface ContextUsage {
  used_tokens: number;
  window_tokens: number | null;
  model: string | null;
}

export type ContextLevel = 'ok' | 'warn' | 'crit';

export const CLAUDE_WINDOW = 200_000;
export const CLAUDE_1M_WINDOW = 1_000_000;
/** Fill at which the meter turns amber / red. */
export const WARN_AT = 75;
export const CRIT_AT = 90;

/**
 * Window size for a session. Codex transcripts state it. Claude transcripts do
 * not, so a `[1m]` model alias in the session's `--model` arg (or usage that
 * already exceeds 200k, which only a 1M window allows) means 1M; anything
 * else is the standard 200k. Other agents have no known window: null hides
 * the meter instead of showing a made-up percentage.
 */
export function contextWindowFor(
  agent: AgentKind,
  usage: ContextUsage,
  argModel?: string,
): number | null {
  if (usage.window_tokens && usage.window_tokens > 0) return usage.window_tokens;
  if (agent !== 'claude') return null;
  if (argModel?.toLowerCase().includes('[1m]')) return CLAUDE_1M_WINDOW;
  if (usage.used_tokens > CLAUDE_WINDOW) return CLAUDE_1M_WINDOW;
  return CLAUDE_WINDOW;
}

/** Whole-number percent, clamped to 0..100. */
export function fillPercent(used: number, window: number): number {
  if (window <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / window) * 100)));
}

export function levelFor(percent: number): ContextLevel {
  if (percent >= CRIT_AT) return 'crit';
  if (percent >= WARN_AT) return 'warn';
  return 'ok';
}

/** 950 -> "950", 12_400 -> "12k", 1_000_000 -> "1M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export interface ContextReading {
  used: number;
  window: number;
  percent: number;
  level: ContextLevel;
}

/** Everything the meter renders, or null when it should stay hidden. */
export function readContext(
  agent: AgentKind,
  usage: ContextUsage | undefined,
  argModel?: string,
): ContextReading | null {
  if (!usage || usage.used_tokens <= 0) return null;
  const window = contextWindowFor(agent, usage, argModel);
  if (!window) return null;
  const percent = fillPercent(usage.used_tokens, window);
  return { used: usage.used_tokens, window, percent, level: levelFor(percent) };
}
