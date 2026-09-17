import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { isCancellationError, reportError } from './errorReporter';

describe('isCancellationError', () => {
  it('matches monaco CancellationError (name and message both "Canceled")', () => {
    const err = new Error('Canceled');
    err.name = 'Canceled';
    expect(isCancellationError(err)).toBe(true);
  });

  it('rejects a plain Error whose message happens to be "Canceled"', () => {
    expect(isCancellationError(new Error('Canceled'))).toBe(false);
  });

  it('rejects an Error named "Canceled" with a different message', () => {
    const err = new Error('operation aborted');
    err.name = 'Canceled';
    expect(isCancellationError(err)).toBe(false);
  });

  it('rejects the bare string "Canceled"', () => {
    expect(isCancellationError('Canceled')).toBe(false);
  });

  it('rejects ordinary errors and non-error values', () => {
    expect(isCancellationError(new Error('boom'))).toBe(false);
    expect(isCancellationError(undefined)).toBe(false);
    expect(isCancellationError(null)).toBe(false);
    expect(isCancellationError({ name: 'Canceled', message: 'Canceled' })).toBe(false);
  });
});

/**
 * xterm 5.5.0's Viewport constructor schedules two unguarded callbacks:
 *
 *   setTimeout(() => this.syncScrollArea())
 *   window.requestAnimationFrame(() => this.syncScrollArea())
 *
 * Neither handle is cancelled on dispose, and syncScrollArea reads
 * `get dimensions(){return this._renderer.value.dimensions}` - where `.value`
 * is undefined once the render service is disposed. A terminal created and
 * torn down inside one frame (a grid re-layout) therefore lands a callback on
 * a dead render service. Nothing is broken by then; the terminal is gone.
 * Upstream race, not ours to fix - but it must not bury real errors in the
 * admin dashboard the way offline sync reports used to.
 */
describe('reportError noise filtering', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    invokeMock.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('drops the disposed-xterm-viewport TypeError', () => {
    reportError('TypeError', "Cannot read properties of undefined (reading 'dimensions')");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('still reports a genuine TypeError about other properties', () => {
    reportError('TypeError', "Cannot read properties of undefined (reading 'config')");

    expect(invokeMock).toHaveBeenCalledOnce();
  });
});
