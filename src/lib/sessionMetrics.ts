/** Per-terminal cumulative metrics, mirrored from the Rust SessionMetricUpdate. */
export interface SessionMetrics {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  linesAdded: number;
  linesRemoved: number;
}

/** The Rust event payload (snake_case, Option fields → possibly undefined). */
export interface TerminalMetricsPayload {
  terminal_id: string;
  cost_usd?: number | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_creation?: number | null;
  lines_added?: number | null;
  lines_removed?: number | null;
}

export function emptyMetrics(): SessionMetrics {
  return {
    costUsd: 0, tokensInput: 0, tokensOutput: 0,
    tokensCacheRead: 0, tokensCacheCreation: 0,
    linesAdded: 0, linesRemoved: 0,
  };
}

export function totalTokens(m: SessionMetrics): number {
  return m.tokensInput + m.tokensOutput + m.tokensCacheRead + m.tokensCacheCreation;
}

/** Apply an event payload over a prior snapshot. The BACKEND already summed the
 *  DELTA exports into a running total before emitting, so each payload is the
 *  full cumulative snapshot - the frontend takes latest-value-wins, NOT summing. */
export function mergeMetrics(prev: SessionMetrics, p: TerminalMetricsPayload): SessionMetrics {
  const pick = (v: number | null | undefined, fallback: number) =>
    typeof v === 'number' ? v : fallback;
  return {
    costUsd: pick(p.cost_usd, prev.costUsd),
    tokensInput: pick(p.tokens_input, prev.tokensInput),
    tokensOutput: pick(p.tokens_output, prev.tokensOutput),
    tokensCacheRead: pick(p.tokens_cache_read, prev.tokensCacheRead),
    tokensCacheCreation: pick(p.tokens_cache_creation, prev.tokensCacheCreation),
    linesAdded: pick(p.lines_added, prev.linesAdded),
    linesRemoved: pick(p.lines_removed, prev.linesRemoved),
  };
}
