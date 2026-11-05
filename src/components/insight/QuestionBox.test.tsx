import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const toastError = vi.fn();
const toastInfo = vi.fn();
const reportInvokeFailure = vi.fn();
vi.mock('../../store/toastStore', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: (...a: unknown[]) => toastInfo(...a) } }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: (...a: unknown[]) => reportInvokeFailure(...a) }));

import { QuestionBox } from './QuestionBox';
import { useTerminalStore } from '../../store/terminalStore';
import { useInsightStore } from '../../store/insightStore';
import { buildAnswerKeys } from '../../lib/questionKeys';
import { registerPromptBar } from '../../lib/terminalFocus';
import type { AskQuestion, InsightRecord, PendingQuestion } from '../../lib/insightModel';

const ID = 't1';
const q1: AskQuestion = {
  question: 'Which database?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'Postgres (Recommended)', description: 'Reliable' },
    { label: 'SQLite', description: 'Embedded' },
  ],
};
const pending = (questions: AskQuestion[]): PendingQuestion => ({ toolUseId: 'tu1', questions });
const useRec = (): InsightRecord =>
  ({ kind: 'tool_use', ts: null, id: 'tu1', name: 'AskUserQuestion', target: null, input: { questions: [q1] } });
const resultRec = (): InsightRecord =>
  ({ kind: 'tool_result', ts: null, tool_use_id: 'tu1', is_error: false, text: 'ok', lines_added: null, lines_removed: null });

const sendKeySequence = vi.fn();
const focus = vi.fn();

function fakeXterm(lines: string[]) {
  return {
    focus,
    rows: lines.length,
    buffer: {
      active: {
        baseY: 0,
        length: lines.length,
        getLine: (i: number) => ({ translateToString: () => lines[i] ?? '' }),
      },
    },
  };
}

function setup(p: PendingQuestion, state: string = 'waiting', screenLines: string[] = ['Database', 'Which database?', '1. Postgres']) {
  useTerminalStore.setState({
    terminalStates: new Map([[ID, state as never]]),
    sendKeySequence,
    terminals: new Map([[ID, { xterm: fakeXterm(screenLines) } as never]]),
  });
  useInsightStore.setState({ byId: new Map([[ID, { records: [useRec()] } as never]]) });
  return render(<QuestionBox terminalId={ID} pending={p} />);
}

beforeEach(() => {
  sendKeySequence.mockReset().mockResolvedValue(undefined);
  focus.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  reportInvokeFailure.mockReset();
});
afterEach(cleanup);

const answerBtn = () => screen.getByRole('button', { name: /^answer/i }) as HTMLButtonElement;

describe('QuestionBox', () => {
  it('renders header, question and option cards', () => {
    setup(pending([q1]));
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Which database?')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Embedded')).toBeTruthy();
    expect(screen.getByText('(Recommended)')).toBeTruthy();
  });

  it('hidden when session is not waiting', () => {
    const { container } = setup(pending([q1]), 'busy');
    expect(container.firstChild).toBeNull();
  });

  it('single select then Answer sends the built keys', () => {
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect(sendKeySequence).not.toHaveBeenCalled();
    fireEvent.click(answerBtn());
    expect(sendKeySequence).toHaveBeenCalledWith(ID, buildAnswerKeys([q1], [{ selected: [1], other: null }]));
  });

  it('other text answer', () => {
    setup(pending([q1]));
    fireEvent.change(screen.getByLabelText(/other answer/i), { target: { value: 'MySQL' } });
    fireEvent.click(answerBtn());
    expect(sendKeySequence).toHaveBeenCalledWith(ID, buildAnswerKeys([q1], [{ selected: [], other: 'MySQL' }]));
  });

  it('multi select toggles', () => {
    const qm: AskQuestion = { ...q1, multiSelect: true };
    setup(pending([qm]));
    const [a, b] = screen.getAllByRole('button', { pressed: false });
    fireEvent.click(a!);
    fireEvent.click(b!);
    fireEvent.click(b!);
    expect(a!.getAttribute('aria-pressed')).toBe('true');
    expect(b!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(answerBtn());
    expect(sendKeySequence).toHaveBeenCalledWith(ID, buildAnswerKeys([qm], [{ selected: [0], other: null }]));
  });

  it('answer disabled until every question is answered', () => {
    const q2: AskQuestion = { ...q1, question: 'Which cache?', header: 'Cache' };
    setup(pending([q1, q2]));
    expect(answerBtn().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    expect(answerBtn().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[2]!);
    expect(answerBtn().disabled).toBe(false);
  });

  it('does not send when the question is no longer pending', () => {
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    act(() => {
      useInsightStore.setState({ byId: new Map([[ID, { records: [useRec(), resultRec()] } as never]]) });
    });
    fireEvent.click(answerBtn());
    expect(sendKeySequence).not.toHaveBeenCalled();
  });

  it('renders comparison chart when options share a numeric unit', () => {
    const qc: AskQuestion = {
      ...q1,
      options: [
        { label: 'A', description: 'Latency 120 ms' },
        { label: 'B', description: 'Latency 80 ms' },
      ],
    };
    const { container } = setup(pending([qc]));
    expect(container.querySelector('svg[role=img]')).not.toBeNull();
  });

  it('no chart when units differ', () => {
    const qc: AskQuestion = {
      ...q1,
      options: [
        { label: 'A', description: 'Latency 120 ms' },
        { label: 'B', description: 'Size 80 MB' },
      ],
    };
    const { container } = setup(pending([qc]));
    expect(container.querySelector('svg[role=img]')).toBeNull();
  });

  it('Esc returns focus to the terminal', () => {
    setup(pending([q1]));
    fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'Escape' });
    expect(focus).toHaveBeenCalled();
  });

  it('hides the Other input for preview questions', () => {
    const qp: AskQuestion = {
      ...q1,
      options: [
        { label: 'A', description: 'a', preview: 'code a' },
        { label: 'B', description: 'b', preview: 'code b' },
      ],
    };
    setup(pending([qp]));
    expect(screen.queryByLabelText(/other answer/i)).toBeNull();
    expect(screen.getByText('code a').closest('pre')).not.toBeNull();
  });

  it('double click sends once', () => {
    let release!: () => void;
    sendKeySequence.mockReturnValue(new Promise<void>((r) => { release = r; }));
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    const btn = answerBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByLabelText(/other answer/i), { key: 'Enter' });
    expect(sendKeySequence).toHaveBeenCalledTimes(1);
    act(() => release());
  });

  it('failure toasts, reports and allows retry', async () => {
    sendKeySequence.mockRejectedValueOnce(new Error('boom'));
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    await act(async () => { fireEvent.click(answerBtn()); });
    expect(toastError).toHaveBeenCalled();
    expect(reportInvokeFailure).toHaveBeenCalledWith('write_to_terminal', expect.any(Error));
    fireEvent.click(answerBtn());
    expect(sendKeySequence).toHaveBeenCalledTimes(2);
  });
  it('does not send when the screen no longer shows the question', () => {
    setup(pending([q1]), 'waiting', ['Allow this command?', '1. Yes', '2. No']);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(answerBtn());
    expect(sendKeySequence).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('The question is no longer on screen');
    expect(reportInvokeFailure).not.toHaveBeenCalled();
  });

  it('refuses with a toast when the question was already answered elsewhere', () => {
    setup(pending([q1]));
    useInsightStore.setState({ byId: new Map([[ID, { records: [useRec(), resultRec()] } as never]]) });
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(answerBtn());
    expect(sendKeySequence).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('The question is no longer on screen');
  });

  it('shownOnScreen renders the box and sends the answer whatever the session state', async () => {
    useTerminalStore.setState({
      terminalStates: new Map([[ID, 'idle' as never]]),
      sendKeySequence,
      terminals: new Map([[ID, { xterm: fakeXterm(['Database', 'Which database?', '1. Postgres']) } as never]]),
    });
    useInsightStore.setState({ byId: new Map([[ID, { records: [useRec()] } as never]]) });
    render(<QuestionBox terminalId={ID} pending={pending([q1])} shownOnScreen />);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    await act(async () => { fireEvent.click(answerBtn()); });
    expect(sendKeySequence).toHaveBeenCalledWith(ID, buildAnswerKeys([q1], [{ selected: [0], other: null }]));
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('a submit after the state left waiting still sends when the question is on screen', async () => {
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    // The poller may flip the state between render and click (a redraw reads as busy).
    useTerminalStore.setState({ terminalStates: new Map([[ID, 'busy' as never]]) });
    await act(async () => { fireEvent.click(answerBtn()); });
    expect(sendKeySequence).toHaveBeenCalledTimes(1);
  });

  it('matches a wrapped question across lines', () => {
    const long: AskQuestion = { ...q1, header: '', question: 'Which database engine should we use for the new service?' };
    setup(pending([long]), 'waiting', ['Which database engine should we', 'use for the new service?']);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.click(answerBtn());
    expect(sendKeySequence).toHaveBeenCalledTimes(1);
  });

  it('focuses the terminal after a successful answer', async () => {
    setup(pending([q1]));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    await act(async () => { fireEvent.click(answerBtn()); });
    expect(focus).toHaveBeenCalled();
  });

  describe('in Insight mode', () => {
    const insightTerminal = () => {
      useTerminalStore.setState({
        terminals: new Map([[ID, {
          xterm: fakeXterm(['Database', 'Which database?', '1. Postgres']),
          config: { view_mode: 'insight', agent: 'claude' },
        } as never]]),
      });
    };

    it('Esc keeps focus in the box and does not reach the layer', () => {
      const outer = vi.fn();
      useTerminalStore.setState({ terminalStates: new Map([[ID, 'waiting' as never]]), sendKeySequence });
      insightTerminal();
      useInsightStore.setState({ byId: new Map([[ID, { records: [useRec()] } as never]]) });
      render(<div onKeyDown={outer}><QuestionBox terminalId={ID} pending={pending([q1])} /></div>);
      const radio = screen.getAllByRole('radio')[0]!;
      radio.focus();
      fireEvent.keyDown(radio, { key: 'Escape' });
      expect(focus).not.toHaveBeenCalled();
      expect(outer).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(radio);
    });

    it('a successful answer focuses the prompt bar, not the terminal', async () => {
      setup(pending([q1]));
      insightTerminal();
      const barFocus = vi.fn();
      const unregister = registerPromptBar(ID, { focus: barFocus, insertText: vi.fn() });
      fireEvent.click(screen.getAllByRole('radio')[0]!);
      await act(async () => { fireEvent.click(answerBtn()); });
      unregister();
      expect(barFocus).toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    });
  });
});
