import { useState } from 'react';
import {
  AlertTriangle, ArrowUpRight, Check, ChevronDown, ChevronRight, ExternalLink, FileDiff, Flag, GitMerge, Inbox, RotateCcw,
  Wrench, X,
} from 'lucide-react';
import { useReviewQueue } from '../hooks/useReviewQueue';
import {
  EVIDENCE_LABEL, REVIEW_GROUPS, type Evidence, type ReviewEntry, type ReviewGroup,
} from '../lib/reviewQueue';
import {
  dismissReviewEntry, finishReviewTask, fixReviewCi, markEntryReviewed, openReviewDiff, openReviewEntry, openReviewPr,
  revisitReviewEntry,
} from '../lib/reviewQueueActions';
import { formatRelativeTime } from '../lib/relativeTime';
import { useNowTick } from '../hooks/useNowTick';
import { BrandIcon } from './BrandIcon';
import { EmptyState } from './ui/EmptyState';
import { Tooltip } from './ui/Tooltip';

const BTN = 'flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium ring-1 ring-inset ring-seam text-text-secondary hover:text-text-primary hover:bg-fill-hover transition-colors';
const ICON_BTN = 'w-7 h-7 flex items-center justify-center rounded-lg text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors';

/** One colour per group, reused for the heading dot and the card's edge. */
const GROUP_COLOR: Record<ReviewGroup, string> = {
  input: 'var(--attention-input)',
  checks: 'var(--error)',
  review: 'var(--attention-ready)',
  merge: 'var(--accent-primary)',
  reviewed: 'rgb(var(--text-tertiary))',
};

const GROUP_LABEL = Object.fromEntries(REVIEW_GROUPS.map(g => [g.id, g.label])) as Record<ReviewGroup, string>;

const SOURCE_TONE: Record<Evidence['source'], string> = {
  observed: 'bg-fill-active text-text-primary',
  ci: 'bg-fill-active text-text-secondary',
  inferred: 'ring-1 ring-inset ring-seam text-text-tertiary',
  reported: 'ring-1 ring-inset ring-seam text-text-tertiary',
};

function EvidenceRow({ e }: { e: Evidence }) {
  const tone = e.tone === 'bad' ? 'text-error' : e.tone === 'good' ? 'text-success' : 'text-text-secondary';
  return (
    <li className="flex items-baseline gap-2 text-[11.5px] leading-[1.5]">
      <span className={`flex-shrink-0 w-[92px] text-center px-1.5 rounded text-[9.5px] font-semibold uppercase tracking-wide leading-[16px] ${SOURCE_TONE[e.source]}`}>
        {EVIDENCE_LABEL[e.source]}
      </span>
      <span className={`min-w-0 break-words ${e.source === 'reported' ? 'text-text-tertiary italic' : tone}`}>
        {e.source === 'reported' ? `"${e.text}"` : e.text}
      </span>
    </li>
  );
}

function EntryCard({ entry, now }: { entry: ReviewEntry; now: number }) {
  const { item } = entry;
  const reviewed = entry.group === 'reviewed';
  // The group heading already names the state; repeat the reason only when
  // it says more (e.g. "Process finished" under Ready to review).
  const showReason = entry.reason !== GROUP_LABEL[entry.group];
  return (
    <div
      className={`relative overflow-hidden rounded-xl ring-1 ring-inset ring-seam bg-elevation-1 ${reviewed ? 'opacity-70' : ''}`}
      data-testid={`review-entry-${entry.key}`}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: GROUP_COLOR[entry.group] }} />
      <button
        type="button"
        onClick={() => openReviewEntry(entry)}
        aria-label={`Open ${entry.title}: ${entry.reason}`}
        className="group w-full text-left pl-4 pr-3.5 pt-3 pb-2 hover:bg-fill-hover transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-shrink-0 w-5 h-5 rounded-md bg-elevation-2 flex items-center justify-center">
            {entry.agentKind ? <BrandIcon kind={entry.agentKind} size={11} /> : <Flag size={11} className="text-accent-primary" />}
          </span>
          <span className="text-[13px] font-semibold text-text-primary truncate">{entry.title}</span>
          {showReason && (
            <span className="flex-shrink-0 px-1.5 rounded text-[10.5px] font-medium leading-[17px]"
              style={{ color: GROUP_COLOR[entry.group], background: `color-mix(in srgb, ${GROUP_COLOR[entry.group]} 14%, transparent)` }}>
              {entry.reason}
            </span>
          )}
          <span className="flex-1" />
          <span className="flex-shrink-0 text-[11px] text-text-tertiary tabular-nums">{formatRelativeTime(now - item.createdAt)}</span>
          <ArrowUpRight size={13} className="flex-shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <div className="mt-1 pl-7 text-[11px] text-text-tertiary truncate font-mono">
          {[entry.agent, entry.location].filter(Boolean).join('  ·  ')}
        </div>
        <div className="mt-1.5 pl-7 text-[12px] text-text-secondary">{entry.context}</div>
        {entry.stale && (
          <div className="mt-1.5 pl-7 flex items-center gap-1.5 text-[11.5px] text-warning"><AlertTriangle size={12} />{entry.stale}</div>
        )}
      </button>
      {entry.evidence.length > 0 && (
        <ul className="pl-11 pr-3.5 pb-2 space-y-1" aria-label="Evidence">
          {entry.evidence.map((e, i) => <EvidenceRow key={i} e={e} />)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-11 pr-3 pb-3 pt-1">
        {entry.canOpenDiff && (
          <button type="button" className={BTN} onClick={() => openReviewDiff(entry)}><FileDiff size={12} />Changes</button>
        )}
        {entry.canFinishTask && item.kind === 'merge' && (
          <Tooltip label="Opens the finish dialog; nothing merges until you confirm there">
            <button type="button" className={BTN} onClick={() => finishReviewTask(entry)}><GitMerge size={12} />Finish task…</button>
          </Tooltip>
        )}
        {entry.canFixCi && (
          <button type="button" className={BTN} onClick={() => fixReviewCi(entry)}><Wrench size={12} />Fix with agent…</button>
        )}
        {item.url && (
          <button type="button" className={BTN} onClick={() => openReviewPr(entry)}><ExternalLink size={12} />Pull request</button>
        )}
        <span className="flex-1" />
        {reviewed ? (
          <button type="button" className={BTN} aria-label={`Revisit ${entry.title}`} onClick={() => revisitReviewEntry(entry)}>
            <RotateCcw size={12} />Revisit
          </button>
        ) : (
          <button type="button" className={BTN} aria-label={`Mark ${entry.title} reviewed`} onClick={() => markEntryReviewed(entry)}>
            <Check size={12} />Mark reviewed
          </button>
        )}
        <Tooltip label="Dismiss until something new happens">
          <button type="button" className={ICON_BTN} aria-label={`Dismiss ${entry.title}`} onClick={() => dismissReviewEntry(entry)}>
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Cross-session Review Queue, opened as a tab (`REVIEW_QUEUE_TAB`). */
export function ReviewQueueView() {
  const entries = useReviewQueue();
  const now = useNowTick();
  const [showReviewed, setShowReviewed] = useState(false);
  const pending = entries.filter(e => e.group !== 'reviewed').length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-6 pt-6 pb-10">
        <header className="mb-5">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-[color-mix(in_srgb,var(--accent-primary)_16%,transparent)] flex items-center justify-center">
              <Inbox size={15} className="text-accent-primary" />
            </span>
            <h1 className="text-[16px] font-semibold text-text-primary">Review Queue</h1>
            <span className="ml-1 px-2 rounded-full text-[11px] font-medium leading-[20px] bg-fill-active text-text-secondary tabular-nums">
              {pending === 0 ? 'All clear' : `${pending} to review`}
            </span>
          </div>
          <p className="mt-2 text-[12px] text-text-tertiary leading-[1.5]">
            Everything across your open sessions that needs a decision. <span className="text-text-secondary">Observed</span> means
            Agentrium saw it happen; agent-reported text is not verified.
          </p>
        </header>

        {entries.length === 0 && (
          <EmptyState
            icon={<Inbox size={22} />}
            title="Nothing to review"
            description="Sessions that wait for input, finish a prompt, fail a check or have a task ready to merge appear here."
          />
        )}

        {REVIEW_GROUPS.map(({ id, label }) => {
          const group = entries.filter(e => e.group === id);
          if (group.length === 0) return null;
          const collapsed = id === 'reviewed' && !showReviewed;
          const heading = (
            <>
              <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: GROUP_COLOR[id] }} />
              <span>{label}</span>
              <span className="tabular-nums text-text-tertiary font-normal">{group.length}</span>
            </>
          );
          return (
            <section key={id} className="mb-6" aria-label={label}>
              {id === 'reviewed' ? (
                <button type="button" onClick={() => setShowReviewed(v => !v)} aria-expanded={!collapsed}
                  className="flex items-center gap-2 mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary hover:text-text-primary">
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  {heading}
                </button>
              ) : (
                <h2 className="flex items-center gap-2 mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{heading}</h2>
              )}
              {!collapsed && (
                <div className="space-y-2.5">
                  {group.map(entry => <EntryCard key={entry.key} entry={entry} now={now} />)}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
