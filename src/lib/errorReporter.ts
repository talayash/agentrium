import { invoke } from '@tauri-apps/api/core';

const MESSAGE_MAX = 2048;
const STACK_MAX = 8192;

// Well-known browser noise that the global error handler picks up but doesn't
// reflect a real bug. Match before sending so we don't pollute telemetry.
const NOISE_PATTERNS: readonly RegExp[] = [
  // Benign ResizeObserver warning fired when callbacks complete out of sync.
  /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/i,
];

export function reportError(kind: string, message: string, stack?: string): void {
  if (NOISE_PATTERNS.some((re) => re.test(message))) {
    return;
  }
  const m = clamp(scrub(message), MESSAGE_MAX);
  const s = stack ? clamp(scrub(stack), STACK_MAX) : null;
  invoke('report_error', { payload: { kind: kind ?? null, message: m, stack: s } }).catch(() => {
    // Swallow — never let the reporter break the app.
  });
}

function scrub(s: string): string {
  // Match the username portion of `C:\Users\<name>` and `file:///C:/Users/<name>`
  // up to (but not including) the next path separator, whitespace, or shell
  // metacharacter. The terminator stays in the output so the rest of the path /
  // surrounding text is preserved.
  return s
    .replace(/C:\\Users\\[^\\/\s'"<>|*?]+/g, 'C:\\Users\\<user>')
    .replace(/file:\/\/\/C:\/Users\/[^/\s'"<>|*?]+/g, 'file:///C:/Users/<user>');
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Convenience wrapper for `.catch` handlers on user-action `invoke(...)` calls.
 * Normalizes the rejection value into a message + stack and forwards to
 * `reportError`. Background pollers should NOT use this — only user-visible
 * actions where a silent failure is a user-facing bug.
 */
export function reportInvokeFailure(kind: string, err: unknown): void {
  if (err instanceof Error) {
    reportError(kind, err.message, err.stack);
    return;
  }
  if (typeof err === 'string') {
    reportError(kind, err);
    return;
  }
  let message: string;
  try {
    message = JSON.stringify(err);
  } catch {
    message = String(err);
  }
  reportError(kind, message);
}
