import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
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
vi.mock('./InsightLayer', () => ({ InsightLayer: () => <div data-testid="insight-layer" /> }));

import { TerminalView } from '../TerminalView';
import { useTerminalStore } from '../../store/terminalStore';

const ID = 't1';

function mountWith(extra: Record<string, unknown>, insight: boolean) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  useTerminalStore.setState({
    terminals: new Map([[ID, { config: { working_directory: 'C:\\p', insight_layer: insight }, ...extra } as never]]),
  });
  return render(<TerminalView terminalId={ID} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalView insight mounting', () => {
  it('TerminalView does not mount the layer when insight_layer is false', async () => {
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
});
