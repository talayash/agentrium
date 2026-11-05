import type { ToolCategory } from '../../lib/insightModel';

const LABELS: Record<ToolCategory, string> = {
  read: 'Read', edit: 'Edit', bash: 'Run', search: 'Search', web: 'Web', agent: 'Agent', other: 'Other',
};
const ORDER: ToolCategory[] = ['read', 'edit', 'bash', 'search', 'web', 'agent', 'other'];

export function ActivityBars({ activity }: { activity: Record<ToolCategory, number> }) {
  const rows = ORDER.filter((c) => activity[c] > 0);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((c) => activity[c]));
  return (
    <div className="space-y-0.5" data-testid="activity-bars">
      {rows.map((c) => (
        <div key={c} className="flex items-center gap-2 text-[11px] text-text-secondary">
          <span className="w-12 shrink-0 text-text-tertiary">{LABELS[c]}</span>
          <div className="h-1.5 flex-1 rounded-full bg-elevation-1">
            <div
              className="h-full rounded-full bg-accent-primary"
              style={{ width: `${Math.max(4, (activity[c] / max) * 100)}%` }}
            />
          </div>
          <span className="w-6 shrink-0 text-right tabular-nums">{activity[c]}</span>
        </div>
      ))}
    </div>
  );
}
