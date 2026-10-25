import { Inbox } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { useReviewPendingCount } from '../../hooks/useReviewQueue';
import { Tooltip } from '../ui/Tooltip';

/**
 * Title-bar entry to the cross-session Review Queue, beside the update pill.
 * Renders nothing while the queue has no unreviewed items (the queue stays
 * reachable from the command palette).
 */
export function ReviewQueuePill() {
  const count = useReviewPendingCount();
  const openReviewQueue = useAppStore((s) => s.openReviewQueue);
  if (count === 0) return null;
  return (
    <Tooltip label="Open Review Queue">
      <button
        onClick={openReviewQueue}
        aria-label={`Review Queue: ${count} item${count === 1 ? '' : 's'} to review`}
        className="no-drag glass-capsule flex items-center gap-1.5 h-8 pl-2.5 pr-1.5 text-[12px] font-medium text-text-primary hover:brightness-110 transition-[filter]"
      >
        <Inbox size={14} strokeWidth={1.9} className="text-text-secondary" />
        <span>Review</span>
        <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-accent-primary text-white text-[11px] font-semibold leading-5 text-center tabular-nums">
          {count}
        </span>
      </button>
    </Tooltip>
  );
}
