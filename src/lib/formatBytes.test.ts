import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it('renders an installer-sized download in MB with one decimal', () => {
    expect(formatBytes(18_400_000)).toBe('18.4 MB');
    expect(formatBytes(11_200_000)).toBe('11.2 MB');
  });

  it('drops to KB below a megabyte', () => {
    expect(formatBytes(64_000)).toBe('64 KB');
  });

  it('keeps raw bytes below a kilobyte', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('climbs to GB for very large payloads', () => {
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });

  it('treats zero and negatives as nothing downloaded yet', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
});
