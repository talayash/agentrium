import { useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { useContextUsageStore } from '../store/contextUsageStore';
import { readContext, formatTokens, WARN_AT, CRIT_AT, type ContextLevel, type ContextReading } from '../lib/contextMeter';
import { focusTerminalInput, insertIntoPromptBar } from '../lib/terminalFocus';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { Tooltip } from './ui/Tooltip';

const LEVEL_COLOR: Record<ContextLevel, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  crit: 'var(--error)',
};

const LEVEL_HINT: Record<ContextLevel, string> = {
  ok: 'Plenty of room left in this conversation.',
  warn: 'Getting full. A long file read or test log can push it to the limit, where the agent compacts on its own.',
  crit: 'Almost full. The agent will compact the conversation soon. Compact now to choose when it happens.',
};

/** The reading for one terminal, or null while the meter is off or has no data. */
export function useContextReading(terminalId: string): ContextReading | null {
  const enabled = useAppStore((s) => s.contextMeterEnabled);
  const setting = useAppStore((s) => s.claudeContextWindow);
  const usage = useContextUsageStore((s) => s.byId.get(terminalId));
  const seenOver200k = useContextUsageStore((s) => s.seenOver200k.has(terminalId));
  const agent = useTerminalStore((s) => s.terminals.get(terminalId)?.config.agent);
  if (!enabled || !agent) return null;
  return readContext(agent, usage, { setting, seenOver200k });
}

const UNKNOWN_HINT =
  "This session's window size is unknown: Claude can run with 200k or 1M depending on your plan and model. Set it in Settings > Appearance to see how full it is.";

const RING_R = 7.5;
const RING_C = 2 * Math.PI * RING_R;

function Ring({ reading }: { reading: ContextReading }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden className="flex-shrink-0">
      <circle cx="10" cy="10" r={RING_R} fill="none" strokeWidth="3" stroke="var(--seam-strong)" />
      <circle
        cx="10"
        cy="10"
        r={RING_R}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke={reading.level ? LEVEL_COLOR[reading.level] : 'transparent'}
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - (reading.percent ?? 0) / 100)}
        transform="rotate(-90 10 10)"
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

/** Session-strip chip: ring + percent, opens a popover with the numbers. */
export function ContextMeter({ terminalId }: { terminalId: string }) {
  const reading = useContextReading(terminalId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!reading) return null;

  const stageCompact = () => {
    setOpen(false);
    // Typed, never sent: the user presses Enter, so a busy agent or a
    // half-written prompt is never interrupted.
    if (!insertIntoPromptBar(terminalId, '/compact')) {
      useTerminalStore
        .getState()
        .writeToTerminal(terminalId, '/compact')
        .catch((err) => {
          toast.error('Could not type /compact', 'Type /compact in the session yourself.');
          reportInvokeFailure('write_to_terminal', err);
        });
    }
    focusTerminalInput(terminalId);
  };

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <Tooltip label="Context window" disabled={open}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={
            reading.percent === null
              ? `Context window: ${formatTokens(reading.used)} tokens used, window size unknown`
              : `Context window ${reading.percent}% full`
          }
          data-context-meter={reading.level ?? 'unknown'}
          className={`flex items-center gap-1.5 h-[18px] pl-1 pr-1.5 rounded-full text-[10px] font-medium tabular-nums ring-1 ring-inset ring-seam-strong transition-colors ${
            open ? 'bg-fill-active text-text-primary' : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary'
          } ${reading.level === 'crit' ? 'context-meter-crit' : ''}`}
        >
          <Ring reading={reading} />
          {reading.percent === null ? formatTokens(reading.used) : `${reading.percent}%`}
        </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label="Context window"
          className="absolute left-0 top-full mt-1.5 z-50 w-[280px] material-popover ct-pop-in rounded-lg p-3 flex flex-col gap-2.5"
          style={{ transformOrigin: 'top left' }}
        >
          {reading.percent === null || reading.window === null || reading.level === null ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[22px] font-semibold text-text-primary tabular-nums leading-none">{formatTokens(reading.used)}</span>
                <span className="text-[12px] text-text-secondary">tokens used</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-text-secondary">{UNKNOWN_HINT}</p>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[22px] font-semibold text-text-primary tabular-nums leading-none">{reading.percent}%</span>
                <span className="text-[12px] text-text-secondary tabular-nums">
                  {formatTokens(reading.used)} of {formatTokens(reading.window)} tokens
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-fill-active" aria-hidden>
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                  style={{ width: `${reading.percent}%`, background: LEVEL_COLOR[reading.level] }}
                />
                <span className="absolute -top-0.5 -bottom-0.5 w-px bg-text-tertiary" style={{ left: `${WARN_AT}%` }} />
                <span className="absolute -top-0.5 -bottom-0.5 w-px bg-text-tertiary" style={{ left: `${CRIT_AT}%` }} />
              </div>
              <p className="text-[11.5px] leading-relaxed text-text-secondary">{LEVEL_HINT[reading.level]}</p>
            </>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={stageCompact}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium text-text-primary ring-1 ring-inset ring-seam-strong hover:bg-fill-hover transition-colors"
            >
              <Minimize2 size={12} strokeWidth={1.9} />
              Type /compact
            </button>
            <span className="text-[11px] text-text-tertiary">then press Enter</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Thin fill bar for a sidebar session card. */
export function ContextBar({ terminalId }: { terminalId: string }) {
  const reading = useContextReading(terminalId);
  // A fill bar needs a window; an unknown one shows only in the session strip.
  if (!reading || reading.percent === null || reading.window === null || reading.level === null) return null;
  return (
    <div
      className="mt-1.5 h-[3px] rounded-full bg-fill-active overflow-hidden"
      title={`Context window ${reading.percent}% full (${formatTokens(reading.used)} of ${formatTokens(reading.window)})`}
      data-context-bar={reading.level}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${reading.percent}%`, background: LEVEL_COLOR[reading.level] }}
      />
    </div>
  );
}
