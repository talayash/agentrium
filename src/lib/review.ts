import type { ReviewComment } from '../store/reviewStore';

/** One brief for the agent: comments grouped by file in first-seen order.
 *  Comments are rendered as given, with no lookup against the current diff. */
export function buildReviewBrief(comments: ReviewComment[]): string {
  const byFile = new Map<string, { heading: string; items: ReviewComment[] }>();
  for (const c of comments) {
    const heading = c.repoPath ? `${c.filePath} (repo: ${c.repoPath})` : c.filePath;
    const group = byFile.get(heading);
    if (group) group.items.push(c);
    else byFile.set(heading, { heading, items: [c] });
  }
  const out = ['# Review comments', '', 'Address each comment below, then summarize what you changed.'];
  for (const { heading, items } of byFile.values()) {
    out.push('', `## ${heading}`);
    for (const c of items) out.push(`- Line ${c.line} (${c.side}) \`${c.snippet}\`: ${c.body}`);
  }
  return out.join('\n');
}
