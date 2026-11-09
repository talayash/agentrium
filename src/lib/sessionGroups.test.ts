import { describe, expect, it } from 'vitest';
import { classifySession, groupSessionIds, mergeGroupOrder } from './sessionGroups';

describe('classifySession', () => {
  it('puts a pending alert under Needs you, whatever the detected state', () => {
    expect(classifySession({ status: 'Running', state: 'idle', pendingAttention: true })).toBe('needs-you');
    expect(classifySession({ status: 'Running', state: 'busy', pendingAttention: true })).toBe('needs-you');
  });

  it('keeps a session waiting for input under Needs you after the alert is acknowledged', () => {
    expect(classifySession({ status: 'Running', state: 'waiting', pendingAttention: false })).toBe('needs-you');
  });

  it('treats a crashed session as needing you', () => {
    expect(classifySession({ status: 'Error', state: undefined, pendingAttention: false })).toBe('needs-you');
  });

  it('shows a running, busy session as Working', () => {
    expect(classifySession({ status: 'Running', state: 'busy', pendingAttention: false })).toBe('working');
  });

  it('does not call a stopped process Working even if the last state was busy', () => {
    expect(classifySession({ status: 'Stopped', state: 'busy', pendingAttention: false })).toBe('idle');
  });

  it('falls back to Idle for idle, stopped and unknown states', () => {
    expect(classifySession({ status: 'Running', state: 'idle', pendingAttention: false })).toBe('idle');
    expect(classifySession({ status: 'Stopped', state: 'stopped', pendingAttention: false })).toBe('idle');
    expect(classifySession({ status: 'Running', state: undefined, pendingAttention: false })).toBe('idle');
  });
});

describe('groupSessionIds', () => {
  it('returns non-empty groups in Needs you, Working, Idle order, keeping input order inside each', () => {
    const groups = { a: 'idle', b: 'working', c: 'needs-you', d: 'idle', e: 'working' } as const;
    const out = groupSessionIds(['a', 'b', 'c', 'd', 'e'], (id) => groups[id as keyof typeof groups]);
    expect(out).toEqual([
      { group: 'needs-you', ids: ['c'] },
      { group: 'working', ids: ['b', 'e'] },
      { group: 'idle', ids: ['a', 'd'] },
    ]);
  });

  it('omits empty groups', () => {
    expect(groupSessionIds(['a'], () => 'idle')).toEqual([{ group: 'idle', ids: ['a'] }]);
    expect(groupSessionIds([], () => 'idle')).toEqual([]);
  });
});

describe('mergeGroupOrder', () => {
  it('reorders a group inside the full order without moving other sessions', () => {
    // b and d are one group; the user drags d above b.
    expect(mergeGroupOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e']);
  });

  it('is a no-op when the group order is unchanged', () => {
    expect(mergeGroupOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('ignores ids that are not in the full order', () => {
    expect(mergeGroupOrder(['a', 'b'], ['z', 'b', 'a'])).toEqual(['b', 'a']);
  });
});
