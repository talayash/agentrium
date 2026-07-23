import { describe, it, expect, vi } from 'vitest';
import { watchWorkerErrors } from './workerErrors';

function fakeWorker(): EventTarget {
  return new EventTarget();
}

describe('watchWorkerErrors', () => {
  it('reports uncaught worker errors with the worker label and location', () => {
    const report = vi.fn();
    const worker = fakeWorker();
    watchWorkerErrors(worker, 'typescript', report);

    worker.dispatchEvent(
      new ErrorEvent('error', {
        message: 'x is not a function',
        filename: 'ts.worker.js',
        lineno: 42,
        colno: 7,
      }),
    );

    expect(report).toHaveBeenCalledTimes(1);
    const [kind, message] = report.mock.calls[0];
    expect(kind).toBe('worker_typescript');
    expect(message).toContain('x is not a function');
    expect(message).toContain('ts.worker.js:42:7');
  });

  it('reports an error event with no details as unknown', () => {
    const report = vi.fn();
    const worker = fakeWorker();
    watchWorkerErrors(worker, 'json', report);

    worker.dispatchEvent(new ErrorEvent('error'));

    expect(report).toHaveBeenCalledTimes(1);
    const [kind, message] = report.mock.calls[0];
    expect(kind).toBe('worker_json');
    expect(message).toContain('unknown worker error');
  });

  it('reports messageerror events', () => {
    const report = vi.fn();
    const worker = fakeWorker();
    watchWorkerErrors(worker, 'editor', report);

    worker.dispatchEvent(new MessageEvent('messageerror'));

    expect(report).toHaveBeenCalledTimes(1);
    const [kind, message] = report.mock.calls[0];
    expect(kind).toBe('worker_editor');
    expect(message).toContain('messageerror');
  });

  it('returns the worker it was given', () => {
    const worker = fakeWorker();
    expect(watchWorkerErrors(worker, 'editor', vi.fn())).toBe(worker);
  });
});
