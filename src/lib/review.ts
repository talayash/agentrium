import type { ReviewComment } from '../store/reviewStore';

/** One brief for the agent: comments grouped by file in first-seen order.
 *  Comments are rendered as given, with no lookup against the current diff. */
export function buildReviewBrief(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.filePath);
    if (list) list.push(c);
    else byFile.set(c.filePath, [c]);
  }
  const out = ['# Review comments', '', 'Address each comment below, then summarize what you changed.'];
  for (const [filePath, list] of byFile) {
    out.push('', `## ${filePath}`);
    for (const c of list) out.push(`- Line ${c.line} (${c.side}) \`${c.snippet}\`: ${c.body}`);
  }
  return out.join('\n');
}
