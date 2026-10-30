import { describe, it, expect, beforeEach } from 'vitest';
import { useReviewStore, commentsFor } from './reviewStore';

const base = { terminalId: 't1', filePath: 'a.ts', side: 'new' as const, line: 3, snippet: 'x', body: 'fix' };

beforeEach(() => useReviewStore.setState({ comments: [] }));

describe('reviewStore', () => {
  it('add, update and remove round-trip', () => {
    const id = useReviewStore.getState().add(base);
    expect(commentsFor('t1')).toHaveLength(1);
    useReviewStore.getState().update(id, 'better');
    expect(commentsFor('t1')[0].body).toBe('better');
    useReviewStore.getState().remove(id);
    expect(commentsFor('t1')).toHaveLength(0);
  });

  it('clearFor leaves other terminals alone', () => {
    useReviewStore.getState().add(base);
    useReviewStore.getState().add({ ...base, terminalId: 't2' });
    useReviewStore.getState().clearFor('t1');
    expect(commentsFor('t1')).toHaveLength(0);
    expect(commentsFor('t2')).toHaveLength(1);
  });
});
