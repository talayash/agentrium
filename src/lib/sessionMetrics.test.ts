import { describe, it, expect } from 'vitest';
import { emptyMetrics, totalTokens, type SessionMetrics } from './sessionMetrics';

describe('sessionMetrics', () => {
  it('emptyMetrics is all zero', () => {
    expect(emptyMetrics()).toEqual({
      costUsd: 0, tokensInput: 0, tokensOutput: 0,
      tokensCacheRead: 0, tokensCacheCreation: 0,
      linesAdded: 0, linesRemoved: 0,
    });
  });

  it('totalTokens sums all four token buckets', () => {
    const m: SessionMetrics = {
      ...emptyMetrics(),
      tokensInput: 100, tokensOutput: 40, tokensCacheRead: 10, tokensCacheCreation: 5,
    };
    expect(totalTokens(m)).toBe(155);
  });
});
