import { confirm } from '@tauri-apps/plugin-dialog';
import { reportInvokeFailure } from './errorReporter';

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
