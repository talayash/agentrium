import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
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
    focus() {}
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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss() {} dispose() {} },
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

const ID = 't1';

function mountWith(extra: Record<string, unknown>, insight: boolean | 'insight') {
  const mode = insight === 'insight' ? 'insight' : insight ? 'mixed' : 'cli';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  useTerminalStore.setState({
    activeTerminalId: ID,
    terminalStates: new Map([[ID, 'idle' as never]]),
    terminals: new Map([[ID, { config: { working_directory: 'C:\\p', view_mode: mode, agent: 'claude', status: 'Running' }, ...extra } as never]]),
  });
  return render(<TerminalView terminalId={ID} />);
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  fit.mockReset();
  useInsightFeed.mockReset();
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

  it('drawer open and close never call fit or resize', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = mountWith({}, 'insight');
    await act(async () => {});
    const container = getByTestId('xterm-container');
    fit.mockReset();
    invoke.mockReset();
    await act(async () => { fireEvent.click(getByLabelText('Show terminal')); });
    expect(queryByTestId('terminal-drawer-header')).not.toBeNull();
    await act(async () => { fireEvent.click(getByLabelText('Close terminal')); });
    expect(queryByTestId('terminal-drawer-header')).toBeNull();
    expect(getByTestId('xterm-container')).toBe(container);
    expect(fit).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('resize_terminal', expect.anything());
  });
});
