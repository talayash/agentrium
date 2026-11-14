import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
type DropHandler = (e: { payload: { type: string; position: { x: number; y: number }; paths?: string[] } }) => void;
let dropHandler: DropHandler | null = null;
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: DropHandler) => { dropHandler = h; return Promise.resolve(() => {}); },
  }),
}));
const xtermFocus = vi.fn();
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; unicode = {}; options = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    onTitleChange() { return { dispose() {} }; }
    onBell() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    buffer = { active: { length: 0, getLine: () => undefined, baseY: 0, viewportY: 0 } };
    element = document.createElement('div');
    textarea = document.createElement('textarea');
    write() {}
    focus() { xtermFocus(); }
    blur() {}
    dispose() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    clear() {}
  },
}));
const fit = vi.fn();
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { fit(); } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
const webglCreated = vi.fn();
const webglDisposed = vi.fn();
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { webglCreated(); } onContextLoss() {} dispose() { webglDisposed(); } },
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }));
vi.mock('../terminalScrollbar', () => ({ attachTerminalScrollbar: () => () => {} }));
vi.mock('../TerminalSearch', () => ({ TerminalSearch: () => null }));
vi.mock('../TerminalStatusBar', () => ({ TerminalStatusBar: () => null }));
vi.mock('./InsightLayer', () => ({
  InsightLayer: (p: { variant?: string }) => <div data-testid="insight-layer" data-variant={p.variant ?? 'panel'} />,
}));
const useInsightFeed = vi.fn();
vi.mock('../../hooks/useInsightFeed', () => ({
  useInsightFeed: (...a: unknown[]) => useInsightFeed(...a),
  useInsightModel: () => ({ turns: [], pendingQuestion: null }),
}));

import { TerminalView } from '../TerminalView';
import { useTerminalStore } from '../../store/terminalStore';
import { useInsightStore } from '../../store/insightStore';
import { focusTerminalInput } from '../../lib/terminalFocus';

const ID = 't1';
const resizeCallbacks: (() => void)[] = [];

function mountWith(extra: Record<string, unknown>, insight: boolean | 'insight', active: string = ID, isVisible = true) {
  const mode = insight === 'insight' ? 'insight' : insight ? 'mixed' : 'cli';
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  useTerminalStore.setState({
    activeTerminalId: active,
    sendKeySequence: vi.fn().mockResolvedValue(undefined),
    terminalStates: new Map([[ID, 'idle' as never]]),
    terminals: new Map([[ID, { config: { working_directory: 'C:\\p', view_mode: mode, agent: 'claude', status: 'Running' }, ...extra } as never]]),
  });
  return render(<TerminalView terminalId={ID} isVisible={isVisible} />);
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  fit.mockReset();
  xtermFocus.mockReset();
  dropHandler = null;
  useInsightFeed.mockReset();
  useInsightStore.setState({ byId: new Map() });
  resizeCallbacks.length = 0;
  webglCreated.mockClear();
  webglDisposed.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TerminalView insight mounting', () => {
  it('TerminalView does not mount the layer in cli mode', async () => {
    const { queryByTestId } = mountWith({}, false);
    await act(async () => {});
    expect(queryByTestId('insight-layer')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('insight_start', expect.anything());
  });

  it('mounts the layer when enabled', async () => {
    const { queryByTestId } = mountWith({}, true);
    await act(async () => {});
    expect(queryByTestId('insight-layer')).not.toBeNull();
  });

  it('does not mount for shell or script-child terminals', async () => {
    const shell = mountWith({ isShellTerminal: true }, true);
    await act(async () => {});
    expect(shell.queryByTestId('insight-layer')).toBeNull();
    cleanup();
    const script = mountWith({ scriptParentId: 'p' }, true);
    await act(async () => {});
    expect(script.queryByTestId('insight-layer')).toBeNull();
  });

  it('cli mode mounts no layer and starts no tailer', async () => {
    const { queryByTestId, queryByPlaceholderText } = mountWith({}, false);
    await act(async () => {});
    expect(queryByTestId('insight-layer')).toBeNull();
    expect(queryByTestId('insight-only-view')).toBeNull();
    expect(queryByPlaceholderText('Message the agent')).toBeNull();
    expect(useInsightFeed).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('insight_start', expect.anything());
  });

  it('mixed mode renders the panel variant unchanged', async () => {
    const { getAllByTestId, queryByTestId, queryByPlaceholderText } = mountWith({}, true);
    await act(async () => {});
    const layers = getAllByTestId('insight-layer');
    expect(layers).toHaveLength(1);
    expect(layers[0]!.dataset.variant).toBe('panel');
    expect(queryByTestId('insight-only-view')).toBeNull();
    expect(queryByPlaceholderText('Message the agent')).toBeNull();
  });

  it('insight mode keeps the terminal mounted at full size behind the layer', async () => {
    const { getByTestId, getAllByTestId } = mountWith({}, 'insight');
    await act(async () => {});
    const container = getByTestId('xterm-container');
    expect(container.className).toContain('absolute');
    expect(container.className).toContain('inset-0');
    expect(container.style.display).not.toBe('none');
    expect(container.className).not.toContain('hidden');
    const view = getByTestId('insight-only-view');
    expect(view.className).toContain('absolute');
    expect(view.className).toContain('inset-0');
    expect(view.parentElement).toBe(container.parentElement);
    // Exactly one layer, so exactly one tailer for this terminal.
    const layers = getAllByTestId('insight-layer');
    expect(layers).toHaveLength(1);
    expect(layers[0]!.dataset.variant).toBe('fill');
    expect(useInsightFeed).not.toHaveBeenCalled();
  });

  it('cli and insight give the xterm container the same box', async () => {
    const cli = mountWith({}, false);
    await act(async () => {});
    const cliClass = cli.getByTestId('xterm-container').className;
    const cliPane = cli.getByTestId('xterm-container').parentElement!.className;
    cleanup();
    const ins = mountWith({}, 'insight');
    await act(async () => {});
    expect(ins.getByTestId('xterm-container').className).toBe(cliClass);
    expect(ins.getByTestId('xterm-container').parentElement!.className).toBe(cliPane);
  });

  it('drawer open and close keep the same xterm container node', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = mountWith({}, 'insight');
    await act(async () => {});
    const container = getByTestId('xterm-container');
    fit.mockReset();
    invoke.mockReset();
    await act(async () => { fireEvent.click(getByLabelText('Show terminal')); });
    expect(queryByTestId('terminal-drawer-close')).not.toBeNull();
    await act(async () => { fireEvent.click(getByLabelText('Close terminal')); });
    expect(queryByTestId('terminal-drawer-close')).toBeNull();
    // ResizeObserver is stubbed here, so this pins the structural guarantee:
    // the drawer never remounts or re-parents the xterm container (no refit).
    expect(getByTestId('xterm-container')).toBe(container);
    expect(fit).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('resize_terminal', expect.anything());
  });

  it('insight mode mount focuses the prompt bar, never the hidden xterm', async () => {
    const { getByPlaceholderText } = mountWith({}, 'insight');
    await act(async () => {});
    expect(document.activeElement).toBe(getByPlaceholderText('Message the agent'));
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('selecting an Insight-mode session ends with focus in the prompt bar, not xterm', async () => {
    const { getByPlaceholderText } = mountWith({}, 'insight', 'other');
    await act(async () => {});
    expect(xtermFocus).not.toHaveBeenCalled();
    // What TerminalTabs / TerminalGrid / NewTerminalModal / CloseSessionConfirm do on select.
    await act(async () => {
      useTerminalStore.setState({ activeTerminalId: ID });
      focusTerminalInput(ID);
    });
    expect(document.activeElement).toBe(getByPlaceholderText('Message the agent'));
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('selecting a CLI session focuses xterm', async () => {
    mountWith({}, false, 'other');
    await act(async () => {});
    xtermFocus.mockReset();
    await act(async () => {
      useTerminalStore.setState({ activeTerminalId: ID });
      focusTerminalInput(ID);
    });
    expect(xtermFocus).toHaveBeenCalledTimes(1);
  });

  it('with the drawer open, selecting focuses xterm', async () => {
    const { getByLabelText } = mountWith({}, 'insight');
    await act(async () => {});
    await act(async () => { fireEvent.click(getByLabelText('Show terminal')); });
    xtermFocus.mockReset();
    focusTerminalInput(ID);
    expect(xtermFocus).toHaveBeenCalledTimes(1);
  });

  const drop = async (paths: string[]) => {
    await act(async () => {});
    expect(dropHandler).not.toBeNull();
    await act(async () => { dropHandler!({ payload: { type: 'drop', position: { x: 0, y: 0 }, paths } }); });
  };

  it('file drop in insight mode goes into the prompt bar draft, not the PTY', async () => {
    const { getByPlaceholderText } = mountWith({}, 'insight');
    const bar = getByPlaceholderText('Message the agent') as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: 'look at' } });
    xtermFocus.mockReset();
    invoke.mockReset();
    act(() => { bar.blur(); });
    await drop(['C:\\my dir\\a.txt']);
    expect(bar.value).toBe('look at "C:\\my dir\\a.txt"');
    expect(document.activeElement).toBe(bar);
    expect(invoke).not.toHaveBeenCalledWith('write_to_terminal', expect.anything());
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('file drop with the drawer open still writes to the PTY', async () => {
    const { getByLabelText, getByPlaceholderText } = mountWith({}, 'insight');
    await act(async () => {});
    await act(async () => { fireEvent.click(getByLabelText('Show terminal')); });
    invoke.mockReset();
    await drop(['C:\\a.txt']);
    expect(invoke).toHaveBeenCalledWith('write_to_terminal', expect.anything());
    expect((getByPlaceholderText('Message the agent') as HTMLTextAreaElement).value).toBe('');
  });

  it('file drop in cli mode writes to the PTY and focuses xterm', async () => {
    mountWith({}, false);
    await act(async () => {});
    invoke.mockReset();
    xtermFocus.mockReset();
    await drop(['C:\\a.txt']);
    expect(invoke).toHaveBeenCalledWith('write_to_terminal', expect.anything());
    expect(xtermFocus).toHaveBeenCalled();
  });
  const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
  const xtermTextarea = () =>
    (useTerminalStore.getState().terminals.get(ID)!.xterm as unknown as { textarea: HTMLTextAreaElement }).textarea;

  it('a hidden insight-mode xterm never pulls focus back on blur', async () => {
    mountWith({}, 'insight');
    await act(async () => {});
    xtermFocus.mockReset();
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    xtermTextarea().dispatchEvent(new Event('blur'));
    await nextFrame();
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('a cli-mode xterm still re-focuses itself when focus drops to the body', async () => {
    mountWith({}, false);
    await act(async () => {});
    xtermFocus.mockReset();
    xtermTextarea().dispatchEvent(new Event('blur'));
    await nextFrame();
    expect(xtermFocus).toHaveBeenCalled();
  });

  const switchMode = (mode: 'cli' | 'mixed') => act(async () => {
    const terminals = new Map(useTerminalStore.getState().terminals);
    const inst = terminals.get(ID)!;
    terminals.set(ID, { ...inst, config: { ...inst.config, view_mode: mode } });
    useTerminalStore.setState({ terminals });
  });

  it('leaving insight mode focuses the xterm of the active session', async () => {
    mountWith({}, 'insight');
    await act(async () => {});
    xtermFocus.mockReset();
    await switchMode('mixed');
    expect(xtermFocus).toHaveBeenCalled();
  });

  it('leaving insight mode does not focus the xterm of a background session', async () => {
    mountWith({}, 'insight', 'other');
    await act(async () => {});
    xtermFocus.mockReset();
    await switchMode('cli');
    expect(xtermFocus).not.toHaveBeenCalled();
  });
});


it('allocates a GPU renderer only while visible, without recreating xterm', async () => {
  const view = mountWith({}, false, ID, false);
  await act(async () => {});
  const xterm = useTerminalStore.getState().terminals.get(ID)?.xterm;
  expect(webglCreated).not.toHaveBeenCalled();
  view.rerender(<TerminalView terminalId={ID} isVisible />);
  expect(webglCreated).toHaveBeenCalledTimes(1);
  view.rerender(<TerminalView terminalId={ID} isVisible={false} />);
  expect(webglDisposed).toHaveBeenCalledTimes(1);
  expect(useTerminalStore.getState().terminals.get(ID)?.xterm).toBe(xterm);
});

it('sends the initial dimensions once and coalesces duplicate resize observations', async () => {
  vi.useFakeTimers();
  mountWith({}, false);
  await act(async () => {});
  expect(invoke.mock.calls.filter(call => call[0] === 'resize_terminal')).toHaveLength(1);
  invoke.mockClear();
  fit.mockClear();
  resizeCallbacks[0]!();
  resizeCallbacks[0]!();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(fit).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalledWith('resize_terminal', expect.anything());
  const xterm = useTerminalStore.getState().terminals.get(ID)!.xterm!;
  Object.assign(xterm, { cols: 100 });
  resizeCallbacks[0]!();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(invoke).toHaveBeenCalledWith('resize_terminal', { id: ID, cols: 100, rows: 24 });
});
