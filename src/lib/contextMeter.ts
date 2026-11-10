import type { AgentKind } from './agents';

/** Wire shape of `get_context_usage` (Rust `context_usage::ContextUsage`). */
export interface ContextUsage {
  used_tokens: number;
  window_tokens: number | null;
  /** Model the transcript reports. Claude strips `[1m]` here, so it is rarely a signal. */
  model: string | null;
  /** Claude: model from `--model`, `ANTHROPIC_MODEL` or settings, in CLI precedence. */
  configured_model: string | null;
}

/** Settings > General (Appearance) override for Claude's window. */
export type ClaudeWindowSetting = 'auto' | '200k' | '1m';

export interface WindowHints {
  setting?: ClaudeWindowSetting;
  /** This terminal has reported more than 200k tokens at some point. */
  seenOver200k?: boolean;
}

export type ContextLevel = 'ok' | 'warn' | 'crit';

export const CLAUDE_WINDOW = 200_000;
export const CLAUDE_1M_WINDOW = 1_000_000;
/** Fill at which the meter turns amber / red. */
export const WARN_AT = 75;
export const CRIT_AT = 90;

const is1m = (model: string | null | undefined) => !!model && model.toLowerCase().includes('[1m]');

/**
 * Window size for a session, `'unknown'` when it cannot be told, or null for
 * agents with no meter. Codex transcripts state it. Claude transcripts do not,
 * and a plain model can be 1M by plan default, so for Claude, in order:
 * usage over 200k now or earlier (only a 1M window allows it), the manual
 * setting, a `[1m]` alias in the configured or transcript model. Anything
 * else is unknown: the meter shows tokens without a made-up percentage.
 */
export function contextWindowFor(
  agent: AgentKind,
  usage: ContextUsage,
  hints: WindowHints = {},
): number | 'unknown' | null {
  if (usage.window_tokens && usage.window_tokens > 0) return usage.window_tokens;
  if (agent !== 'claude') return null;
  if (hints.seenOver200k || usage.used_tokens > CLAUDE_WINDOW) return CLAUDE_1M_WINDOW;
  if (hints.setting === '200k') return CLAUDE_WINDOW;
  if (hints.setting === '1m') return CLAUDE_1M_WINDOW;
  if (is1m(usage.configured_model) || is1m(usage.model)) return CLAUDE_1M_WINDOW;
  return 'unknown';
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

/** `window`, `percent` and `level` are null when the window is unknown. */
export interface ContextReading {
  used: number;
  window: number | null;
  percent: number | null;
  level: ContextLevel | null;
}

/** Everything the meter renders, or null when it should stay hidden. */
export function readContext(
  agent: AgentKind,
  usage: ContextUsage | undefined,
  hints: WindowHints = {},
): ContextReading | null {
  if (!usage || usage.used_tokens <= 0) return null;
  const window = contextWindowFor(agent, usage, hints);
  if (!window) return null;
  if (window === 'unknown') return { used: usage.used_tokens, window: null, percent: null, level: null };
  const percent = fillPercent(usage.used_tokens, window);
  return { used: usage.used_tokens, window, percent, level: levelFor(percent) };
}
