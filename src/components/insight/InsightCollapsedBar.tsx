import { ChevronRight } from 'lucide-react';

interface Props { headline: string | null; hasQuestion: boolean; onExpand: () => void }

export function InsightCollapsedBar({ headline, hasQuestion, onExpand }: Props) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand insight layer"
      className="flex h-7 w-full shrink-0 items-center gap-2 border-b border-seam bg-elevation-1 px-2 text-left text-[11px] text-text-secondary hover:text-text-primary"
    >
      <ChevronRight size={12} strokeWidth={1.75} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate">{headline ?? 'Insight'}</span>
      {hasQuestion && (
        <span className="shrink-0 rounded bg-accent-primary/20 px-1.5 py-px text-[10px] font-medium text-accent-primary">
          Question
        </span>
      )}
    </button>
  );
}
