import { describe, it, expect, vi, beforeEach } from 'vitest';

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const reporter = vi.hoisted(() => ({ reportInvokeFailure: vi.fn(), reportError: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: dialog.confirm }));
vi.mock('./errorReporter', () => ({
  reportInvokeFailure: reporter.reportInvokeFailure,
  reportError: reporter.reportError,
}));

import { confirmAction, installConfirmShim } from './confirmDialog';

beforeEach(() => {
  dialog.confirm.mockReset();
  reporter.reportInvokeFailure.mockReset();
  reporter.reportError.mockReset();
});

describe('confirmAction', () => {
  it('resolves true when the native dialog is accepted and passes a warning kind', async () => {
    dialog.confirm.mockResolvedValue(true);
    await expect(confirmAction('Delete it?')).resolves.toBe(true);
    expect(dialog.confirm).toHaveBeenCalledWith('Delete it?', expect.objectContaining({ kind: 'warning' }));
  });

  it('resolves false when the dialog is cancelled', async () => {
    dialog.confirm.mockResolvedValue(false);
    await expect(confirmAction('Delete it?')).resolves.toBe(false);
  });

  it('forwards a custom title and OK label', async () => {
    dialog.confirm.mockResolvedValue(true);
    await confirmAction('Drop stash?', { title: 'Stash', okLabel: 'Drop' });
    expect(dialog.confirm).toHaveBeenCalledWith('Drop stash?', expect.objectContaining({ title: 'Stash', okLabel: 'Drop' }));
  });

  it('never confirms when the dialog itself fails, and reports the failure', async () => {
    dialog.confirm.mockRejectedValue(new Error('plugin:dialog|confirm not allowed by ACL'));
    await expect(confirmAction('Delete it?')).resolves.toBe(false);
    expect(reporter.reportInvokeFailure).toHaveBeenCalledWith('plugin:dialog|confirm', expect.any(Error));
  });
});

describe('installConfirmShim', () => {
  it('answers false synchronously so a truthy Promise can never green-light a destructive branch', () => {
    // tauri-plugin-dialog's init script leaves window.confirm returning a
    // Promise that invokes the removed plugin:dialog|confirm command.
    const pluginShim = vi.fn(() => Promise.resolve(true));
    window.confirm = pluginShim as unknown as typeof window.confirm;

    installConfirmShim();
    const answer = window.confirm('Undo across files?');

    expect(answer).toBe(false);
    expect(pluginShim).not.toHaveBeenCalled();
  });

  it('reports every prompt it swallows so a lost confirmation is never silent', () => {
    window.confirm = (() => true) as unknown as typeof window.confirm;
    installConfirmShim();

    window.confirm('Undo across files?');

    expect(reporter.reportError).toHaveBeenCalledWith(
      'ConfirmShim',
      expect.stringContaining('Undo across files?'),
    );
  });
});
