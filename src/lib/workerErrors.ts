import { reportError } from './errorReporter';

type Report = (kind: string, message: string, stack?: string) => void;

/**
 * Uncaught errors inside a Web Worker never reach `window.onerror` - the
 * worker just dies and its features (e.g. Monaco language smarts) silently
 * stop working. Attach listeners so those crashes reach telemetry.
 * Uses addEventListener so the host library's own handlers are untouched.
 */
export function watchWorkerErrors<T extends EventTarget>(
  worker: T,
  label: string,
  report: Report = reportError,
): T {
  const kind = `worker_${label}`;
  worker.addEventListener('error', (ev) => {
    const e = ev as ErrorEvent;
    const loc = e.filename ? ` (${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0})` : '';
    report(kind, `${e.message || 'unknown worker error'}${loc}`, e.error?.stack);
  });
  worker.addEventListener('messageerror', () => {
    report(kind, 'messageerror: worker message could not be deserialized');
  });
  return worker;
}
