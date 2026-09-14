import { describe, it, expect, vi, beforeEach } from 'vitest';

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const reporter = vi.hoisted(() => ({ reportInvokeFailure: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: dialog.confirm }));
vi.mock('./errorReporter', () => ({ reportInvokeFailure: reporter.reportInvokeFailure }));

import { confirmAction } from './confirmDialog';

beforeEach(() => {
  dialog.confirm.mockReset();
  reporter.reportInvokeFailure.mockReset();
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
