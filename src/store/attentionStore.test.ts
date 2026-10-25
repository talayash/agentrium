import { beforeEach, describe, expect, it } from 'vitest';
import { channelOf, useAttentionStore } from './attentionStore';

beforeEach(() => useAttentionStore.setState({ items: [] }));
const base = { terminalId: 't', targetId: 't', title: 'T', detail: 'd' };

describe('attention store review state', () => {
  it('puts task items in their own channel', () => {
    expect(channelOf('merge')).toBe('task');
    const s = useAttentionStore.getState();
    s.put({ ...base, kind: 'review' });
    s.put({ ...base, kind: 'merge' });
    expect(useAttentionStore.getState().items.map(i => i.kind).sort()).toEqual(['merge', 'review']);
  });

  it('marks reviewed, revisits, and clears the mark when a new event replaces the slot', () => {
    const s = useAttentionStore.getState();
    s.put({ ...base, kind: 'review' });
    s.markReviewed('t', 'session');
    expect(useAttentionStore.getState().items[0].reviewedAt).toEqual(expect.any(Number));
    s.revisit('t', 'session');
    expect(useAttentionStore.getState().items[0].reviewedAt).toBeUndefined();
    s.markReviewed('t', 'session');
    s.put({ ...base, kind: 'input' });
    expect(useAttentionStore.getState().items).toHaveLength(1);
    expect(useAttentionStore.getState().items[0]).toMatchObject({ kind: 'input' });
    expect(useAttentionStore.getState().items[0].reviewedAt).toBeUndefined();
  });

  it('only touches the named channel and is a no-op for unknown slots', () => {
    const s = useAttentionStore.getState();
    s.put({ ...base, kind: 'review' });
    s.put({ ...base, kind: 'ci' });
    const before = useAttentionStore.getState().items;
    s.markReviewed('other', 'session');
    expect(useAttentionStore.getState().items).toBe(before);
    s.markReviewed('t', 'pr');
    expect(useAttentionStore.getState().items.find(i => i.kind === 'review')?.reviewedAt).toBeUndefined();
    expect(useAttentionStore.getState().items.find(i => i.kind === 'ci')?.reviewedAt).toEqual(expect.any(Number));
  });
});
