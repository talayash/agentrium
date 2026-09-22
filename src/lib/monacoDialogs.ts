import { confirmAction } from './confirmDialog';
import { toast } from '../store/toastStore';

interface Confirmation {
  message: string;
  detail?: string;
  primaryButton?: string;
}

interface PromptButton<T> {
  label: string;
  run: (result: { checkboxChecked: boolean }) => T | Promise<T>;
}

// Monaco's standalone service calls window.confirm synchronously. Tauri's
// replacement returns a Promise and invokes a removed plugin command. Supply
// the async service instead, for both ordinary editors and diff editors.
export const monacoDialogService = {
  async confirm(options: Confirmation) {
    const confirmed = await confirmAction(
      [options.message, options.detail].filter(Boolean).join('\n\n'),
      { okLabel: options.primaryButton?.replace(/&&/g, '') },
    );
    return { confirmed, checkboxChecked: false };
  },

  async prompt<T>(options: Confirmation & {
    buttons?: PromptButton<T>[];
    cancelButton?: PromptButton<T> | string | boolean;
  }) {
    // Match Monaco standalone's primary-action/cancel presentation.
    const primary = options.buttons?.[0];
    const { confirmed } = await monacoDialogService.confirm({
      ...options,
      primaryButton: primary?.label,
    });
    const button = confirmed ? primary
      : typeof options.cancelButton === 'object' ? options.cancelButton : undefined;
    return { result: await button?.run({ checkboxChecked: false }) };
  },

  async error(message: string, detail?: string) {
    toast.error(message, detail);
  },
};
