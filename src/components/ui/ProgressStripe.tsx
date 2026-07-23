import { computeStripeStyle } from '../../lib/progressStripe';

interface ProgressStripeProps {
  /** 0..1 for determinate; omit for indeterminate. Values outside [0,1] are clamped. */
  value?: number;
  /** Reserves the 2 px row without rendering the bar - prevents layout shift. */
  hidden?: boolean;
  className?: string;
}

/**
 * 2 px indeterminate or determinate progress bar. Sits inside `PanelHeader`
 * or above a status bar. Uses the app's accent color; reduce-motion falls
 * back to a static bar via the global `[data-reduce-motion]` cascade
 * (animation duration collapses to 0.001s).
 */
export function ProgressStripe({ value, hidden = false, className = '' }: ProgressStripeProps) {
  const style = computeStripeStyle(value);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={style.mode === 'determinate' ? value : undefined}
      className={`relative h-[2px] overflow-hidden ${className}`}
    >
      {!hidden && style.mode === 'indeterminate' && (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 bg-accent-primary"
          style={{
            width: '30%',
            left: '-30%',
            animation: 'ct-stripe-slide 1400ms cubic-bezier(0.25, 0.1, 0.25, 1) infinite',
          }}
        />
      )}
      {!hidden && style.mode === 'determinate' && (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 left-0 bg-accent-primary"
          style={{ width: style.width }}
        />
      )}
    </div>
  );
}
