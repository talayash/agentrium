import { GitPullRequest, GitMerge, GitPullRequestClosed, GitPullRequestDraft, Wrench } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { usePrStore } from '../store/prStore';
import { prKey, type CiState, type PrRef, type PullRequestStatus } from '../lib/pullRequests';
import { openPullRequestUrl, sendFailingChecksToAgent } from '../lib/pullRequestActions';
import { Tooltip } from './ui/Tooltip';

type Shown = 'open' | 'draft' | 'merged' | 'closed';

const STATE_STYLE: Record<Shown, { cls: string; label: string; Icon: typeof GitPullRequest }> = {
  open: { cls: 'bg-emerald-500/12 text-emerald-400', label: 'Open', Icon: GitPullRequest },
  draft: { cls: 'bg-zinc-500/15 text-text-secondary', label: 'Draft', Icon: GitPullRequestDraft },
  merged: { cls: 'bg-purple-500/12 text-purple-400', label: 'Merged', Icon: GitMerge },
  closed: { cls: 'bg-red-500/12 text-red-400', label: 'Closed', Icon: GitPullRequestClosed },
};

const CI_DOT: Record<Exclude<CiState, 'none'>, { cls: string; label: string }> = {
  pending: { cls: 'bg-amber-400 animate-pulse', label: 'CI running' },
  success: { cls: 'bg-emerald-400', label: 'CI passed' },
  failure: { cls: 'bg-red-500', label: 'CI failing' },
};

const REVIEW: Record<NonNullable<PullRequestStatus['review_decision']>, string> = {
  approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required',
};

function shownState(ref: PrRef, status: PullRequestStatus | undefined): Shown {
  const state = status?.state ?? ref.lastState ?? 'open';
  if (state === 'open' && status?.draft) return 'draft';
  return state;
}

export function tooltipFor(ref: PrRef, status: PullRequestStatus | undefined): string {
  const shown = shownState(ref, status);
  const live = shown === 'open' || shown === 'draft';
  const lines = [`Pull request #${ref.number} · ${STATE_STYLE[shown].label}`];
  if (live && status?.review_decision) lines.push(REVIEW[status.review_decision]);
  if (live && status?.mergeable === 'conflicting') lines.push('Has merge conflicts');
  // Review and CI only matter while the PR can still change.
  const ci = live ? status?.ci.state ?? ref.lastCi : undefined;
  if (ci && ci !== 'none') {
    const failing = status?.ci.failing ?? [];
    lines.push(ci === 'failure' && failing.length
      ? `CI failing: ${failing.slice(0, 4).map(c => c.name).join(', ')}${failing.length > 4 ? ` +${failing.length - 4}` : ''}`
      : CI_DOT[ci].label);
  }
  if (!status) lines.push('Live status needs a signed-in gh or glab CLI');
  lines.push('Click to open');
  return lines.join('\n');
}

/** PR number, state and CI dot for the branch a terminal is on. Renders
 *  nothing until the branch has a tracked PR. */
export function PrChip({ terminalId, compact = false }: { terminalId: string; compact?: boolean }) {
  const key = useTerminalStore((s) => {
    const git = s.gitInfoCache.get(terminalId);
    const t = s.terminals.get(terminalId);
    if (!t || !git?.is_git_repo || !git.current_branch) return null;
    return prKey(git.worktree_root ?? t.config.working_directory, git.current_branch);
  });
  const ref = usePrStore((s) => (key ? s.refs[key] : undefined));
  const status = usePrStore((s) => (key ? s.statuses[key] : undefined));
  if (!ref) return null;

  const shown = shownState(ref, status);
  const { cls, Icon } = STATE_STYLE[shown];
  const ci = shown === 'open' || shown === 'draft' ? (status?.ci.state ?? ref.lastCi ?? 'none') : 'none';
  const label = tooltipFor(ref, status);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <span className="flex items-center gap-0.5 flex-shrink-0" onPointerDown={stop} onClick={stop}>
      <Tooltip label={label} multiline>
        <button
          type="button"
          onClick={() => openPullRequestUrl(status?.url ?? ref.url)}
          aria-label={label.replace(/\n/g, '. ')}
          className={`flex items-center gap-0.5 rounded-md font-medium tabular-nums hover:brightness-125 transition ${cls} ${
            compact ? 'text-[10px] px-1 h-[15px]' : 'text-[10.5px] px-1.5 h-[16px]'
          }`}
        >
          <Icon size={compact ? 9 : 10} strokeWidth={2} className="flex-shrink-0" />
          <span>#{ref.number}</span>
          {ci !== 'none' && <span aria-hidden className={`ml-0.5 w-1.5 h-1.5 rounded-full ${CI_DOT[ci].cls}`} />}
        </button>
      </Tooltip>
      {ci === 'failure' && !compact && (
        <Tooltip label="Send failing checks to agent">
          <button
            type="button"
            onClick={() => { void sendFailingChecksToAgent(terminalId); }}
            aria-label="Send failing checks to agent"
            className="w-[16px] h-[16px] flex items-center justify-center rounded-md text-red-400 hover:bg-fill-hover"
          >
            <Wrench size={10} strokeWidth={2} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}
