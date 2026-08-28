import { describe, expect, it } from 'vitest';
import { LatestRequest } from './latestRequest';

describe('LatestRequest', () => {
  it('accepts only the newest request', () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();

    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);
  });

  it('invalidates an in-flight request without starting another', () => {
    const requests = new LatestRequest();
    const pending = requests.begin();
    requests.invalidate();

    expect(requests.isCurrent(pending)).toBe(false);
  });
});
