import { describe, expect, it } from 'vitest';
import { bannerMotion } from './motionTokens';

describe('bannerMotion', () => {
  it('enters from the right edge', () => {
    expect(bannerMotion.initial.x).toBeGreaterThan(0);
  });

  it('travels a short distance, so it reads as arriving rather than flying in', () => {
    // macOS banners slide a few points. A long runway reads as attention-seeking;
    // the previous toast flew 88px.
    expect(bannerMotion.initial.x).toBeLessThanOrEqual(32);
  });

  it('leaves along the path it entered (spatial consistency)', () => {
    expect(bannerMotion.exit.x).toBe(bannerMotion.initial.x);
  });
});
