import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const toastError = vi.fn();
const reportInvokeFailure = vi.fn();
vi.mock('../../store/toastStore', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn() } }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: (...a: unknown[]) => reportInvokeFailure(...a) }));

import { createRef } from 'react';
import { PromptBar, type PromptBarHandle } from './PromptBar';
import { promptBarFor } from '../../lib/terminalFocus';
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
    expect(sendKeySequence).toHaveBeenCalledWith(ID, ['\x15'.repeat(4), 'hello', '\r']);
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

  it('Esc that cancels an IME composition does not interrupt the agent', () => {
    setup({ busy: true });
    fireEvent.keyDown(box(), { key: 'Escape', isComposing: true });
    expect(sendKeySequence).not.toHaveBeenCalled();
  });

  it('marks the textarea as terminal input so global shortcuts still fire', () => {
    setup();
    expect(box().hasAttribute('data-terminal-input')).toBe(true);
  });

  it('the Terminal button is prominent only while the terminal needs the user', () => {
    const { rerender } = setup();
    expect(screen.getByLabelText('Show terminal').dataset.attention).toBeUndefined();
    rerender(<PromptBar terminalId={ID} disabledReason="The agent is waiting in the terminal" busy={false} onShowTerminal={onShowTerminal} terminalNeedsYou />);
    const btn = screen.getByLabelText('Show terminal');
    expect(btn.dataset.attention).toBe('true');
    expect(btn.className).toContain('bg-accent-primary');
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

  it('exposes focus() through its ref', () => {
    const ref = createRef<PromptBarHandle>();
    render(<PromptBar ref={ref} terminalId={ID} disabledReason={null} busy={false} onShowTerminal={onShowTerminal} />);
    expect(document.activeElement).not.toBe(box());
    act(() => { ref.current?.focus(); });
    expect(document.activeElement).toBe(box());
  });

  it('a focus request while disabled is honoured once the bar is enabled', () => {
    useTerminalStore.setState({ activeTerminalId: ID });
    const ref = createRef<PromptBarHandle>();
    const { rerender } = render(<PromptBar ref={ref} terminalId={ID} disabledReason="Answer the question above" busy={false} onShowTerminal={onShowTerminal} />);
    act(() => { ref.current?.focus(); });
    expect(document.activeElement).not.toBe(box());
    rerender(<PromptBar ref={ref} terminalId={ID} disabledReason={null} busy={false} onShowTerminal={onShowTerminal} />);
    expect(document.activeElement).toBe(box());
  });

  it('registers itself so a dropped path is appended to the draft', () => {
    setup();
    type('see');
    act(() => { promptBarFor(ID)?.insertText('"C:/a b.txt"'); });
    expect(box().value).toBe('see "C:/a b.txt"');
    expect(document.activeElement).toBe(box());
    cleanup();
    expect(promptBarFor(ID)).toBeUndefined();
  });
});
