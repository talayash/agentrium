import { describe, expect, it, vi } from 'vitest';

vi.mock('./confirmDialog', () => ({ confirmAction: vi.fn() }));
import { confirmAction } from './confirmDialog';
import { monacoDialogService } from './monacoDialogs';

describe('Monaco native dialogs', () => {
  it('waits for an answer instead of treating a Promise as confirmation', async () => {
    let answer!: (value: boolean) => void;
    vi.mocked(confirmAction).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const run = vi.fn();
    const pending = monacoDialogService.prompt({ message: 'Remove line terminators?', buttons: [{ label: '&&Remove', run }] });
    expect(run).not.toHaveBeenCalled();
    answer(false);
    await pending;
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the primary action only after acceptance', async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    const run = vi.fn().mockResolvedValue('removed');
    await expect(monacoDialogService.prompt({ message: 'Remove?', detail: 'Unusual line terminators', buttons: [{ label: '&&Remove', run }] })).resolves.toEqual({ result: 'removed' });
    expect(confirmAction).toHaveBeenCalledWith('Remove?\n\nUnusual line terminators', { okLabel: 'Remove' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('returns a boolean cancellation result for editor confirmations', async () => {
    vi.mocked(confirmAction).mockResolvedValue(false);
    await expect(monacoDialogService.confirm({ message: 'Undo across files?' })).resolves.toEqual({ confirmed: false, checkboxChecked: false });
  });
});
