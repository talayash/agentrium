import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { totalTokens } from '../lib/sessionMetrics';

export function SessionMetricsPanel({ terminalId }: { terminalId: string }) {
  const metrics = useTerminalStore((s) => s.terminalMetrics.get(terminalId));
  const budget = useAppStore((s) => s.sessionBudgetUsd);
  if (!metrics) return null;

  const pct = budget > 0 ? Math.min(100, (metrics.costUsd / budget) * 100) : 0;
  const over = budget > 0 && metrics.costUsd >= budget;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between text-[11px] py-0.5">
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text-secondary tabular-nums">{value}</span>
    </div>
  );

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
      <Row label="Input tokens" value={metrics.tokensInput.toLocaleString()} />
      <Row label="Output tokens" value={metrics.tokensOutput.toLocaleString()} />
      <Row label="Cache read" value={metrics.tokensCacheRead.toLocaleString()} />
      <Row label="Total tokens" value={totalTokens(metrics).toLocaleString()} />
    </div>
  );
}
