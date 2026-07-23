import { describe, it, expect } from 'vitest';
import { isCancellationError } from './errorReporter';

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
