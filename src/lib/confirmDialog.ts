import { confirm } from '@tauri-apps/plugin-dialog';
import { reportError, reportInvokeFailure } from './errorReporter';

export interface ConfirmOptions {
  title?: string;
  okLabel?: string;
  kind?: 'info' | 'warning' | 'error';
}

/**
 * Native yes/no dialog, awaited.
 *
 * Never use `window.confirm` in this app: Tauri's dialog plugin replaces it
 * with an async call to `plugin:dialog|confirm`, so `if (window.confirm(...))`
 * sees a pending Promise (always truthy) and the destructive action runs before
 * the user has answered. Every failure of the dialog itself resolves to false,
 * so nothing irreversible ever happens without an explicit yes.
 */
export async function confirmAction(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  try {
    return await confirm(message, {
      title: opts.title ?? 'Agentrium',
      kind: opts.kind ?? 'warning',
      okLabel: opts.okLabel,
      cancelLabel: 'Cancel',
    });
  } catch (err) {
    reportInvokeFailure('plugin:dialog|confirm', err);
    return false;
  }
}

/**
 * Neutralize the `window.confirm` that tauri-plugin-dialog injects.
 *
 * The plugin's init script (`init-iife.js`, still shipped in 2.7.x) replaces
 * `window.confirm` with an async invoke of `plugin:dialog|confirm`. That
 * command no longer exists: the plugin registers only `open`, `save` and
 * `message`, and `dialog:allow-confirm` is now a deprecated alias for
 * `dialog:allow-message`. So every call fails with "Command
 * plugin:dialog|confirm not allowed by ACL" - no capability can grant it -
 * and, because the replacement is async, the caller gets a Promise that is
 * always truthy and runs its destructive branch anyway.
 *
 * Our own code uses `confirmAction`, but third-party code does not: Monaco's
 * StandaloneDialogService calls `window.confirm` directly. Replace it with a
 * synchronous `false` so a swallowed prompt can never green-light a
 * destructive action, and never leaves an unhandled rejection behind.
 * Callers that need a real answer must use `confirmAction`.
 */
export function installConfirmShim(): void {
  window.confirm = (message?: string): boolean => {
    reportError('ConfirmShim', `Blocked window.confirm: ${message ?? ''}`);
    return false;
  };
}
