import { describe, expect, it } from 'vitest';
import { setupFailed, setupFailureMessage } from './taskSetup';
import type { RaceCheckResult } from './races';

const ok: RaceCheckResult = { exit_code: 0, timed_out: false, cancelled: false, duration_ms: 1, output_tail: '', truncated: false };

describe('setupFailed', () => {
  it('is false only for a clean exit 0', () => {
    expect(setupFailed(ok)).toBe(false);
    expect(setupFailed({ ...ok, exit_code: 1 })).toBe(true);
    expect(setupFailed({ ...ok, exit_code: null })).toBe(true);
    expect(setupFailed({ ...ok, timed_out: true })).toBe(true);
    expect(setupFailed({ ...ok, cancelled: true })).toBe(true);
  });
});

describe('setupFailureMessage', () => {
  it('names a timeout and a cancel', () => {
    expect(setupFailureMessage({ ...ok, exit_code: null, timed_out: true })).toBe('Setup command timed out.');
    expect(setupFailureMessage({ ...ok, exit_code: null, cancelled: true })).toBe('Setup was cancelled.');
  });

  it('includes the exit code and the last 2000 characters of output', () => {
    const out = 'x'.repeat(3000) + 'END';
    const msg = setupFailureMessage({ ...ok, exit_code: 2, output_tail: out });
    expect(msg.startsWith('Setup command failed (exit 2).\n\n')).toBe(true);
    expect(msg.endsWith('END')).toBe(true);
    expect(msg.length).toBe('Setup command failed (exit 2).\n\n'.length + 2000);
  });
});
