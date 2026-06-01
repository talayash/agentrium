import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { totalTokens } from '../lib/sessionMetrics';

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  /** Render as the reconciling total: separator above + emphasized text. */
  strong?: boolean;
  /** Dim the row to group it visually (used for the cache sub-rows). */
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between text-[11px] py-0.5 ${
        strong ? 'mt-1 pt-1 border-t border-[var(--ij-divider)]' : ''
      }`}
    >
      <span className={strong ? 'text-text-secondary font-medium' : muted ? 'text-text-tertiary/70' : 'text-text-tertiary'}>
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
    <div className="px-3 py-2 border-t border-[var(--ij-divider)] bg-elevation-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-text-tertiary uppercase tracking-wide">Session cost (est.)</span>
        <span className={`text-[13px] font-medium tabular-nums ${over ? 'text-red-400' : 'text-emerald-400'}`}>
          ${metrics.costUsd.toFixed(2)}
        </span>
      </div>
      {budget > 0 && (
        <div className="h-1 rounded-full bg-white/[0.08] mb-2 overflow-hidden">
          <div
            className={`h-full ${over ? 'bg-red-400' : 'bg-emerald-400'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {/* Real throughput: fresh tokens Claude read/generated this session. */}
      <Row label="Input tokens" value={metrics.tokensInput.toLocaleString()} />
      <Row label="Output tokens" value={metrics.tokensOutput.toLocaleString()} />
      {/* Cache traffic — re-reading the conversation context each turn. High
          volume but billed at a steep discount, so it dominates token counts
          without dominating cost. */}
      <Row label="Cache read" value={metrics.tokensCacheRead.toLocaleString()} muted />
      <Row label="Cache write" value={metrics.tokensCacheCreation.toLocaleString()} muted />
      <Row label="All tokens (incl. cache)" value={totalTokens(metrics).toLocaleString()} strong />
    </div>
  );
}
