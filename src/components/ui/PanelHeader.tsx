import type { ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ProgressStripe } from './ProgressStripe';

interface PanelHeaderProps {
  title: ReactNode;
  /** Optional trailing count next to the title, e.g. sessions count. */
  count?: number;
  /** Renders a chevron on the left; when true, the title becomes a click target. */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Right-slot: usually a small cluster of icon buttons. */
  actions?: ReactNode;
  /** When present, renders a 2px progress bar under the header - shows either
   *  an indeterminate slide or a determinate fill (value 0..1). */
  progress?: { active: boolean; value?: number };
  className?: string;
}

/**
 * 26 px header strip for tool windows. Converges the divergent panel-title
 * styles across the codebase onto one primitive: uppercase 11 px muted title,
 * optional count, optional actions cluster (right), optional 2 px progress
 * stripe below the header row.
 */
export function PanelHeader({
  title,
  count,
  collapsible = false,
  collapsed = false,
  onToggleCollapsed,
  actions,
  progress,
  className = '',
}: PanelHeaderProps) {
  const titleNode = (
    <span className="flex items-center gap-1.5 text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em]">
      {collapsible && (
        collapsed ? (
          <ChevronRight size={11} strokeWidth={2} />
        ) : (
          <ChevronDown size={11} strokeWidth={2} />
        )
      )}
      {title}
      {typeof count === 'number' && count > 0 && (
        <span className="text-text-tertiary text-[10.5px] tabular-nums normal-case tracking-normal font-normal ml-0.5">
          {count}
        </span>
      )}
    </span>
  );

  return (
    <div className={className}>
      <div className="h-[26px] flex items-center justify-between px-3 border-b border-seam">
        {collapsible ? (
          <button
            onClick={onToggleCollapsed}
            className="flex items-center hover:text-text-primary transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {titleNode}
          </button>
        ) : (
          titleNode
        )}
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {progress?.active && (
        <ProgressStripe value={progress.value} className="-mt-[1px]" />
      )}
    </div>
  );
}
