import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const toastError = vi.fn();
const reportInvokeFailure = vi.fn();
vi.mock('../../store/toastStore', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn() } }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: (...a: unknown[]) => reportInvokeFailure(...a) }));

import { PromptBar } from './PromptBar';
import { useTerminalStore } from '../../store/terminalStore';
import { useInsightStore } from '../../store/insightStore';

const ID = 't1';
const sendKeySequence = vi.fn();
const onShowTerminal = vi.fn();

function setup(over: { disabledReason?: string | null; busy?: boolean } = {}) {
  return render(
    <PromptBar terminalId={ID} disabledReason={over.disabledReason ?? null} busy={over.busy ?? false} onShowTerminal={onShowTerminal} />,
  );
}
const box = () => screen.getByPlaceholderText('Message the agent') as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
const enter = () => fireEvent.keyDown(box(), { key: 'Enter' });

beforeEach(() => {
  sendKeySequence.mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  reportInvokeFailure.mockReset();
  onShowTerminal.mockReset();
  useTerminalStore.setState({ sendKeySequence });
  useInsightStore.setState({ byId: new Map() });
});
afterEach(cleanup);

describe('PromptBar', () => {
  it('Enter sends and clears', async () => {
    setup();
    type('hello');
    await act(async () => { enter(); });
    expect(sendKeySequence).toHaveBeenCalledWith(ID, ['hello', '\r']);
    expect(box().value).toBe('');
  });

  it('Shift+Enter inserts newline', () => {
    setup();
    type('a');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(sendKeySequence).not.toHaveBeenCalled();
  });

  it('Up recalls previous prompt and Down returns to draft', async () => {
    setup();
    type('first');
    await act(async () => { enter(); });
    type('second');
    await act(async () => { enter(); });
    type('draft');
    box().setSelectionRange(0, 0);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('second');
    box().setSelectionRange(0, 0);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('first');
    box().setSelectionRange(box().value.length, box().value.length);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('second');
    box().setSelectionRange(box().value.length, box().value.length);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('draft');
  });

  it('disabled keeps text and shows the reason', () => {
    const { rerender } = setup();
    type('keep me');
    rerender(<PromptBar terminalId={ID} disabledReason="Agent is waiting for approval" busy={false} onShowTerminal={onShowTerminal} />);
    const ta = screen.getByDisplayValue('keep me') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Agent is waiting for approval')).toBeTruthy();
  });

  it('Stop sends Esc while busy', () => {
    setup({ busy: true });
    fireEvent.click(screen.getByRole('button', { name: /^stop/i }));
    expect(sendKeySequence).toHaveBeenCalledWith(ID, ['\x1b']);
  });

  it('Esc in textarea interrupts only while busy', () => {
    const { unmount } = setup({ busy: false });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(sendKeySequence).not.toHaveBeenCalled();
    unmount();
    setup({ busy: true });
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(box(), { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(sendKeySequence).toHaveBeenCalledWith(ID, ['\x1b']);
    expect(outer).not.toHaveBeenCalled();
  });

  it('send failure restores the text and toasts', async () => {
    sendKeySequence.mockRejectedValueOnce(new Error('boom'));
    setup();
    type('hello');
    await act(async () => { enter(); });
    expect(toastError).toHaveBeenCalled();
    expect(reportInvokeFailure).toHaveBeenCalledWith('write_to_terminal', expect.any(Error));
    expect(box().value).toBe('hello');
  });
});
