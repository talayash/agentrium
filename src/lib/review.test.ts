import { describe, it, expect } from 'vitest';
import { buildReviewBrief } from './review';
import type { ReviewComment } from '../store/reviewStore';

const c = (o: Partial<ReviewComment>): ReviewComment => ({
  id: 'i', terminalId: 't1', filePath: 'a.ts', side: 'new', line: 42, snippet: 'const x = 1;', body: 'rename', ...o,
});

describe('buildReviewBrief', () => {
  it('has the header, groups by file in first-seen order, marks old side', () => {
    const out = buildReviewBrief([
      c({ filePath: 'b.ts' }),
      c({ filePath: 'a.ts', line: 7, side: 'old', body: 'why removed' }),
      c({ filePath: 'b.ts', line: 50, body: 'second' }),
    ]);
    expect(out.startsWith('# Review comments\n')).toBe(true);
    expect(out).toContain('Address each comment below, then summarize what you changed.');
    expect(out.indexOf('## b.ts')).toBeLessThan(out.indexOf('## a.ts'));
    expect(out).toContain('- Line 42 (new) `const x = 1;`: rename');
    expect(out).toContain('- Line 7 (old) `const x = 1;`: why removed');
    expect(out.match(/## b\.ts/g)).toHaveLength(1);
  });

  it('brief keeps comments whose line left the diff', () => {
    const out = buildReviewBrief([c({ line: 9999, body: 'stale' })]);
    expect(out).toContain('- Line 9999 (new) `const x = 1;`: stale');
  });
});

describe('buildReviewBrief repo identity', () => {
  it('heading includes the repo when set and keeps repos apart', () => {
    const out = buildReviewBrief([c({ repoPath: 'D:/other' }), c({})]);
    expect(out).toContain('## a.ts (repo: D:/other)');
    expect(out).toContain('## a.ts\n');
  });
});
