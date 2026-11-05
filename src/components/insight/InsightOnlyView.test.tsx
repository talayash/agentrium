import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock('../../store/toastStore', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
const restartTerminal = vi.fn();
vi.mock('../../lib/restartTerminal', () => ({ restartTerminal: (...a: unknown[]) => restartTerminal(...a) }));

import { InsightOnlyView } from './InsightOnlyView';
import { useInsightStore } from '../../store/insightStore';
import { useTerminalStore } from '../../store/terminalStore';
import type { InsightRecord } from '../../lib/insightModel';
import type { SessionState } from '../../lib/terminalState';

const ID = 't1';
const prompt = (text: string): InsightRecord => ({ kind: 'user_prompt', ts: '2026-01-01T00:00:00Z', text });
const reply = (text: string): InsightRecord => ({ kind: 'assistant_text', ts: '2026-01-01T00:00:10Z', text });
const ask: InsightRecord = {
  kind: 'tool_use', ts: null, id: 'q', name: 'AskUserQuestion', target: null,
  input: { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] },
};

const xtermFocus = vi.fn();
const makeXterm = () => ({
  focus: xtermFocus,
  scrollToLine: vi.fn(),
  buffer: { active: { length: 0, baseY: 0, viewportY: 0, getLine: () => undefined } },
});

function seed(opts: {
  records?: InsightRecord[];
  state?: SessionState;
  status?: string;
  active?: string | null;
} = {}) {
  useInsightStore.setState({
    byId: new Map([[ID, {
      records: opts.records ?? [prompt('p'), reply('All done.')],
      supported: true, heightPx: null, collapsed: null, expandedTurn: null,
    }]]),
  });
  useTerminalStore.setState({
    terminals: new Map([[ID, {
      xterm: makeXterm(),
      config: { id: ID, working_directory: 'C:\\proj', view_mode: 'insight', agent: 'claude', status: opts.status ?? 'Running' },
    } as never]]),
    terminalMetrics: new Map(),
    terminalStates: new Map([[ID, (opts.state ?? 'idle') as never]]),
    gitInfoCache: new Map(),
    activeTerminalId: opts.active === undefined ? ID : opts.active,
    sendKeySequence: vi.fn().mockResolvedValue(undefined),
  });
}

async function mount() {
  await act(async () => { render(<InsightOnlyView terminalId={ID} />); });
}
const bar = () => screen.getByPlaceholderText('Message the agent') as HTMLTextAreaElement;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ supported: true });
  xtermFocus.mockReset();
  restartTerminal.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InsightOnlyView', () => {
  it('renders the fill layer, status line and prompt bar', async () => {
    seed();
    await mount();
    expect(screen.getAllByText('All done.')[0]!).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByLabelText('Collapse insight layer')).toBeNull();
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(bar().disabled).toBe(false);
  });

  it('status line shows Working... with a spinner while busy', async () => {
    seed({ state: 'busy' });
    await mount();
    expect(screen.getByText('Working...')).toBeTruthy();
    expect(screen.getByTestId('insight-status-spinner')).toBeTruthy();
    expect(screen.getByLabelText('Stop')).toBeTruthy();
  });

  it('status line shows Waiting for you while waiting', async () => {
    seed({ state: 'waiting' });
    await mount();
    expect(screen.getByText('Waiting for you')).toBeTruthy();
  });

  it('prompt bar disabled with "Answer the question above" while a question is pending', async () => {
    seed({ records: [prompt('p'), ask] });
    await mount();
    expect(bar().disabled).toBe(true);
    expect(screen.getByText('Answer the question above')).toBeTruthy();
  });

  it('session ended shows Restart and disables the bar', async () => {
    seed({ status: 'Stopped' });
    await mount();
    expect(screen.getAllByText('Session ended').length).toBeGreaterThan(0);
    expect(bar().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(restartTerminal).toHaveBeenCalledWith(ID);
  });

  it('an Error status also counts as ended', async () => {
    seed({ status: 'Error' });
    await mount();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(bar().disabled).toBe(true);
  });

  it('switching to insight focuses the prompt bar', async () => {
    seed();
    await mount();
    expect(document.activeElement).toBe(bar());
  });

  it('never steals focus when another terminal is active', async () => {
    seed({ active: 'other' });
    await mount();
    expect(document.activeElement).not.toBe(bar());
  });

  it('selecting an insight session focuses the prompt bar', async () => {
    seed({ active: 'other' });
    await mount();
    await act(async () => { useTerminalStore.setState({ activeTerminalId: ID }); });
    expect(document.activeElement).toBe(bar());
  });

  it('Esc in the layer focuses the prompt bar', async () => {
    seed();
    await mount();
    const turnButton = screen.getAllByText('All done.')[0]!;
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    fireEvent.keyDown(turnButton, { key: 'Escape' });
    expect(document.activeElement).toBe(bar());
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('drawer: opening hides the view and focuses the terminal, closing returns focus to the bar', async () => {
    seed();
    await mount();
    const view = screen.getByTestId('insight-only-view');
    expect(view.style.visibility).not.toBe('hidden');
    expect(screen.queryByTestId('terminal-drawer-header')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show terminal'));
    expect(view.style.visibility).toBe('hidden');
    expect(view.className).toContain('pointer-events-none');
    expect(screen.getByTestId('terminal-drawer-header').textContent).toContain('Terminal');
    expect(screen.getByText('The terminal is open')).toBeTruthy();
    expect(xtermFocus).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Close terminal'));
    expect(view.style.visibility).not.toBe('hidden');
    expect(screen.queryByTestId('terminal-drawer-header')).toBeNull();
    expect(document.activeElement).toBe(bar());
  });

  it('drawer does not move focus when another terminal is active', async () => {
    seed({ active: 'other' });
    await mount();
    fireEvent.click(screen.getByLabelText('Show terminal'));
    expect(xtermFocus).not.toHaveBeenCalled();
  });
});
