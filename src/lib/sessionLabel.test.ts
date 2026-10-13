import { describe, expect, it } from 'vitest';
import { nextSessionLabel } from './sessionLabel';

describe('nextSessionLabel', () => {
  it('uses the bare profile name when no session of that profile is open', () => {
    expect(nextSessionLabel('New Admin', [])).toBe('New Admin');
    expect(nextSessionLabel('New Admin', ['WGCP-13066', 'Shell'])).toBe('New Admin');
  });

  it('adds an index only once the profile already has a session', () => {
    expect(nextSessionLabel('New Admin', ['New Admin'])).toBe('New Admin 2');
    expect(nextSessionLabel('New Admin', ['New Admin', 'New Admin 2'])).toBe('New Admin 3');
  });

  it('goes one past the highest index in use', () => {
    expect(nextSessionLabel('Shell', ['Shell 4'])).toBe('Shell 5');
  });

  it('does not count other profiles that share a prefix', () => {
    expect(nextSessionLabel('Admin', ['New Admin', 'Admin Tools', 'Admin2'])).toBe('Admin');
  });

  it('treats regex characters in the profile name literally', () => {
    expect(nextSessionLabel('C++ (dev)', ['C++ (dev)'])).toBe('C++ (dev) 2');
  });
});
