import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { totalTokens } from '../lib/sessionMetrics';

function Row({
  label,
  value,
  tooltip,
  strong,
  muted,
}: {
  label: string;
  value: string;
  /** Native hover tooltip explaining what the row counts. */
  tooltip?: string;
  /** Render as the reconciling total: separator above + emphasized text. */
  strong?: boolean;
  /** Group the row as a sub-item (used for the cache sub-rows). Indents rather
   *  than dimming, so the text stays at the accessible text-tertiary contrast. */
  muted?: boolean;
}) {
  return (
    <div
      title={tooltip}
      className={`flex items-center justify-between text-[11px] py-0.5 ${tooltip ? 'cursor-help' : ''} ${
        strong ? 'mt-1 pt-1 border-t border-seam-strong' : ''
      }`}
    >
      <span className={`${strong ? 'text-text-secondary font-medium' : 'text-text-tertiary'} ${muted ? 'pl-2.5' : ''}`}>
        {label}
      </span>
      <span className={`tabular-nums ${strong ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
        {value}
      </span>
    </div>
  );
}

export function SessionMetricsPanel({ terminalId }: { terminalId: string }) {
  const metrics = useTerminalStore((s) => s.terminalMetrics.get(terminalId));
  const budget = useAppStore((s) => s.sessionBudgetUsd);
  if (!metrics) return null;

  const pct = budget > 0 ? Math.min(100, (metrics.costUsd / budget) * 100) : 0;
  const over = budget > 0 && metrics.costUsd >= budget;

  return (
    <div className="px-3 py-2 border-t border-seam-strong bg-elevation-1">
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="text-[11px] text-text-tertiary uppercase tracking-wide cursor-help"
          title="Claude's own estimated cost for this session, from its telemetry - an estimate, not a billed amount."
        >
          Session cost (est.)
        </span>
        <span className={`text-[13px] font-medium tabular-nums ${over ? 'text-red-400' : 'text-emerald-400'}`}>
          ${metrics.costUsd.toFixed(2)}
        </span>
      </div>
      {budget > 0 && (
        <div className="h-1 rounded-full bg-fill-active mb-2 overflow-hidden">
          <div
            className={`h-full ${over ? 'bg-red-400' : 'bg-emerald-400'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {/* Real throughput: fresh tokens Claude read/generated this session. */}
      <Row
        label="Input tokens"
        value={metrics.tokensInput.toLocaleString()}
        tooltip="Fresh (uncached) prompt tokens the model read this session - system prompt, tool definitions, project context, and your messages. Not just what you typed: a one-word message still sends the model the full context."
      />
      <Row
        label="Output tokens"
        value={metrics.tokensOutput.toLocaleString()}
        tooltip="Tokens the model generated in its replies this session."
      />
      {/* Cache traffic - re-reading the conversation context each turn. High
          volume but billed at a steep discount, so it dominates token counts
          without dominating cost. */}
      <Row
        label="Cache read"
        value={metrics.tokensCacheRead.toLocaleString()}
        muted
        tooltip="Context re-read from the prompt cache each turn (system prompt, tool defs, files). High volume across a session but billed at roughly 1/10th the price of fresh input - this is why the token count is large while the cost stays low."
      />
      <Row
        label="Cache write"
        value={metrics.tokensCacheCreation.toLocaleString()}
        muted
        tooltip="New content written into the prompt cache so later turns can read it back cheaply instead of re-sending it at full price."
      />
      <Row
        label="All tokens (incl. cache)"
        value={totalTokens(metrics).toLocaleString()}
        strong
        tooltip="Sum of input + output + cache read + cache write across the whole session. Dominated by cache reads, so it looks large even when the cost is small."
      />
    </div>
  );
}
