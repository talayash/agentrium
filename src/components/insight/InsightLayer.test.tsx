import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock('../../store/toastStore', () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

import { InsightLayer } from './InsightLayer';
import { findLineInBuffer } from '../../lib/insightJump';
import { useInsightStore } from '../../store/insightStore';
import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';
import type { InsightRecord } from '../../lib/insightModel';

const ID = 't1';
const prompt = (text: string): InsightRecord => ({ kind: 'user_prompt', ts: '2026-01-01T00:00:00Z', text });
const reply = (text: string): InsightRecord => ({ kind: 'assistant_text', ts: '2026-01-01T00:00:10Z', text });
const edit = (id: string, target: string): InsightRecord =>
  ({ kind: 'tool_use', ts: null, id, name: 'Edit', target, input: null });
const editOk = (id: string): InsightRecord =>
  ({ kind: 'tool_result', ts: null, tool_use_id: id, is_error: false, text: 'ok', lines_added: 3, lines_removed: 1 });
const bash = (id: string): InsightRecord => ({ kind: 'tool_use', ts: null, id, name: 'Bash', target: 'npm test', input: null });
const bashFail = (id: string, text: string): InsightRecord =>
  ({ kind: 'tool_result', ts: null, tool_use_id: id, is_error: true, text, lines_added: null, lines_removed: null });

const focus = vi.fn();
const scrollToLine = vi.fn();
const makeXterm = (lines: string[]) => ({
  focus,
  scrollToLine,
  buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } },
});

let resizeCb: ((entries: { contentRect: { height: number } }[]) => void) | null = null;

function seed(records: InsightRecord[], opts: { xterm?: unknown; git?: unknown; ui?: object } = {}) {
  useInsightStore.setState({
    byId: new Map([[ID, { records, supported: true, heightPx: null, collapsed: null, expandedTurn: null, ...opts.ui }]]),
  });
  useTerminalStore.setState({
    terminals: new Map([[ID, { xterm: opts.xterm ?? makeXterm([]), config: { working_directory: 'C:\\proj', insight_layer: true } } as never]]),
    terminalMetrics: new Map(),
    terminalStates: new Map([[ID, 'idle' as never]]),
    gitInfoCache: new Map(opts.git ? [[ID, opts.git as never]] : []),
  });
}

beforeEach(() => {
  invoke.mockResolvedValue({ supported: true });
  resizeCb = null;
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: never) { resizeCb = cb; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InsightLayer', () => {
  it('renders newest turn digest with stat tiles', async () => {
    seed([prompt('p'), edit('a', 'src\\a.ts'), editOk('a'), bash('b'), reply('Done. All set.')]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.getByText('Done.')).toBeTruthy();
    expect(screen.getByText('Files changed')).toBeTruthy();
    expect(screen.getByText('Commands run')).toBeTruthy();
    expect(screen.queryByText('Errors')).toBeNull();
    expect(screen.getByText('src\\a.ts')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('older turns are collapsed rows and expand on click', async () => {
    seed([prompt('one'), reply('First answer.'), prompt('two'), reply('Second answer.')]);
    const { rerender } = render(<InsightLayer terminalId={ID} />);
    await act(async () => {});
    const row = screen.getByText('Turn 1: First answer.');
    expect(screen.queryByText('Files changed')).toBeNull();
    fireEvent.click(row);
    rerender(<InsightLayer terminalId={ID} />);
    expect(useInsightStore.getState().byId.get(ID)?.expandedTurn).toBe(1);
    expect(screen.queryByText('Turn 1: First answer.')).toBeNull();
    expect(screen.getByText('Turn 1')).toBeTruthy();
  });

  it('file click opens the editor tab', async () => {
    const openFileTab = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ openFileTab } as never);
    seed([prompt('p'), edit('a', 'src\\a.ts'), editOk('a'), reply('ok')]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    fireEvent.click(screen.getByText('src\\a.ts'));
    expect(openFileTab).toHaveBeenCalledWith('C:\\proj\\src\\a.ts');
  });

  it('jump to output scrolls xterm', async () => {
    seed(
      [prompt('p'), bash('b'), bashFail('b', 'boom happened here'), reply('failed')],
      { xterm: makeXterm(['one', 'boom happened here', 'three']) },
    );
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    fireEvent.click(screen.getByText('Jump to output'));
    expect(scrollToLine).toHaveBeenCalledWith(1);
  });

  it('jump to output toasts when the text is gone', async () => {
    seed([prompt('p'), bash('b'), bashFail('b', 'boom'), reply('failed')], { xterm: makeXterm(['nothing']) });
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    fireEvent.click(screen.getByText('Jump to output'));
    expect(scrollToLine).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('Not found in the terminal output');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('collapsed bar shows headline and question badge', async () => {
    const ask: InsightRecord = {
      kind: 'tool_use', ts: null, id: 'q', name: 'AskUserQuestion', target: null,
      input: { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] },
    };
    seed([prompt('p'), reply('Headline here.'), ask], { ui: { collapsed: true } });
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.getByText('Headline here.')).toBeTruthy();
    expect(screen.getByText('Question')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Expand insight layer'));
    expect(useInsightStore.getState().byId.get(ID)?.collapsed).toBe(false);
  });

  it('starts collapsed in a short pane', async () => {
    seed([prompt('p'), reply('Short pane.')]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.queryByTestId('insight-body')).not.toBeNull();
    await act(async () => { resizeCb?.([{ contentRect: { height: 300 } }]); });
    expect(screen.queryByTestId('insight-body')).toBeNull();
    expect(screen.getByLabelText('Expand insight layer')).toBeTruthy();
  });

  it('does not collapse a short pane once the user has chosen', async () => {
    seed([prompt('p'), reply('Chosen.')], { ui: { collapsed: false } });
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    await act(async () => { resizeCb?.([{ contentRect: { height: 300 } }]); });
    expect(screen.queryByTestId('insight-body')).not.toBeNull();
  });

  it('does not steal focus on update', async () => {
    seed([prompt('p'), reply('One.')]);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    await act(async () => {
      useInsightStore.getState().append(ID, [prompt('q'), reply('Two.')], false);
    });
    expect(document.activeElement).toBe(outside);
    expect(focus).not.toHaveBeenCalled();
    outside.remove();
  });

  it('Escape focuses xterm and separator arrows resize', async () => {
    seed([prompt('p'), reply('One.')]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    const sep = screen.getByRole('separator');
    expect(sep.getAttribute('aria-orientation')).toBe('horizontal');
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(useInsightStore.getState().byId.get(ID)?.heightPx).toBe(before + 16);
    fireEvent.keyDown(sep, { key: 'Escape' });
    expect(focus).toHaveBeenCalled();
  });

  it('waits for the transcript when there are no records', async () => {
    seed([]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.getByText('Waiting for the session transcript...')).toBeTruthy();
  });
});

describe('InsightLayer sizing (R5)', () => {
  const bodyEl = () => screen.getByTestId('insight-body') as HTMLElement;

  it('content growth does not change the panel height', async () => {
    seed([prompt('p'), reply('One.')]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    const before = bodyEl().style.height;
    expect(before).toMatch(/px$/);
    await act(async () => {
      useInsightStore.getState().append(ID, [prompt('q'), edit('a', 'x.ts'), editOk('a'), reply('Two.')], false);
    });
    expect(screen.getAllByText('Two.').length).toBeGreaterThan(0);
    expect(bodyEl().style.height).toBe(before);
    expect(bodyEl().style.maxHeight).toBe('');
  });

  it('drag does not commit until mouseup, then commits once clamped', async () => {
    seed([prompt('p'), reply('One.')]);
    const setHeight = vi.fn();
    useInsightStore.setState({ setHeight } as never);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    await act(async () => { resizeCb?.([{ contentRect: { height: 1000 } }]); });
    fireEvent.mouseDown(screen.getByRole('separator'), { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 150 });
    fireEvent.mouseMove(window, { clientY: 200 });
    expect(setHeight).not.toHaveBeenCalled();
    expect(screen.queryByTestId('insight-drag-guide')).not.toBeNull();
    fireEvent.mouseUp(window, { clientY: 5000 });
    expect(setHeight).toHaveBeenCalledTimes(1);
    expect(setHeight).toHaveBeenCalledWith(ID, 700);
    expect(screen.queryByTestId('insight-drag-guide')).toBeNull();
  });

  it('drag clamps to the 120 px minimum', async () => {
    seed([prompt('p'), reply('One.')]);
    const setHeight = vi.fn();
    useInsightStore.setState({ setHeight } as never);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    fireEvent.mouseDown(screen.getByRole('separator'), { clientY: 500 });
    fireEvent.mouseUp(window, { clientY: 0 });
    expect(setHeight).toHaveBeenCalledWith(ID, 120);
  });

  it('unmount mid-drag removes the window listeners', async () => {
    seed([prompt('p'), reply('One.')]);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<InsightLayer terminalId={ID} />);
    await act(async () => {});
    fireEvent.mouseDown(screen.getByRole('separator'), { clientY: 100 });
    unmount();
    const types = removeSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('mousemove');
    expect(types).toContain('mouseup');
  });

  it('a small pane renders collapsed on the first render with no expanded flash', () => {
    seed([prompt('p'), reply('Tiny.')]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 250 } as DOMRect);
    const seen: boolean[] = [];
    const obs = new MutationObserver(() => seen.push(!!document.querySelector('[data-testid="insight-body"]')));
    obs.observe(document.body, { childList: true, subtree: true });
    render(<InsightLayer terminalId={ID} />);
    obs.disconnect();
    expect(screen.queryByTestId('insight-body')).toBeNull();
    expect(screen.getByLabelText('Expand insight layer')).toBeTruthy();
    expect(seen.every((v) => !v)).toBe(true);
  });

  it('negative duration renders no duration text', async () => {
    const early: InsightRecord = { kind: 'user_prompt', ts: '2026-01-01T00:00:10Z', text: 'p' };
    const late: InsightRecord = { kind: 'assistant_text', ts: '2026-01-01T00:00:00Z', text: 'Backwards.' };
    seed([early, late]);
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    const text = screen.getByTestId('turn-digest').textContent ?? '';
    expect(text).toContain('Backwards.');
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).toBe('Backwards.Backwards.');
  });
});

describe('findLineInBuffer', () => {
  it('scans bottom-up and returns null when absent', () => {
    const x = makeXterm(['err x', 'mid', 'err x']) as never;
    expect(findLineInBuffer(x, 'err x')).toBe(2);
    expect(findLineInBuffer(x, 'nope')).toBeNull();
  });

  it('shows the no-structured-data fallback when unsupported', async () => {
    invoke.mockResolvedValue({ supported: false });
    seed([], { ui: { supported: false } });
    useTerminalStore.setState({ terminalStates: new Map([[ID, 'busy' as never]]) });
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.getByText('No structured data for this agent')).toBeTruthy();
    expect(screen.getByText('busy')).toBeTruthy();
    expect(screen.queryByText('An option menu is open in the terminal')).toBeNull();
  });

  it('fallback shows the menu hint only when waiting with an option menu', async () => {
    invoke.mockResolvedValue({ supported: false });
    seed([], { ui: { supported: false }, xterm: makeXterm(['Pick', '❯ 1. Yes', '  2. No']) });
    useTerminalStore.setState({ terminalStates: new Map([[ID, 'waiting' as never]]) });
    await act(async () => { render(<InsightLayer terminalId={ID} />); });
    expect(screen.getByText('An option menu is open in the terminal')).toBeTruthy();
  });
});
